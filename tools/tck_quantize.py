"""
tck_quantize.py — Compress .tck tractography files with a per-streamline
quantize-then-delta scheme, exploiting near-constant step size (segment
length) within each streamline, which real tractography output — fixed
integration step size — has by construction.

Requires: numpy, dipy, nibabel for READING the source
.tck and, in reconstruction mode, WRITING a real .tck back out.

Designed by Rembrandt Bakker, September 2026.
Implemented by claude.ai.

The delta-compressed format itself has its own custom byte layout.

THE SCHEME, per streamline:
  1. Store the first point exactly, as float32 (the streamline's origin).
  2. Compute max_seg = the longest segment (distance between consecutive
     points) in this streamline.
  3. Q = max_seg / divisor (divisor default 127 — see below for why not
     128). This is the quantization unit.
  4. Independently round EVERY point (relative to the start) onto the
     Q-grid: quantized[i] = round((pts[i] - start) / Q), an integer
     vector. This step is where all the quantization error is
     introduced — once, per point, independently.
  5. Store the DIFFERENCE between consecutive ALREADY-quantized integer
     points (not a delta of continuous values, and not a delta computed
     before quantizing). This is the crucial ordering: because both
     quantized[i] and quantized[i-1] are already integers, their
     difference is exactly an integer too — computing and later summing
     these deltas introduces NO additional rounding at all beyond the
     one-time per-point rounding in step 4. Reconstruction is therefore
     start + Q * cumsum(deltas), which recovers EXACTLY start +
     Q*quantized[i] for every i — mathematically identical to
     quantizing each point directly, not a "predict from the previous
     ACTUAL point" scheme (which is what naive delta-then-quantize does,
     and which DOES accumulate error as a random walk — verified
     directly in this project's own earlier testing).
  6. Since max_seg is by definition the LONGEST segment in the
     streamline, no per-axis delta component (in quantization units)
     can exceed the divisor in magnitude — bounding every stored delta
     to a small, fixed range regardless of how long the streamline is.

Worst-case error per point is bounded by (max_seg / divisor) / 2 per
axis (half a quantization step, from rounding).

FILE FORMAT — JSON-headered for easy browser-side reading:

    MAGIC          8 bytes   b'TCKDQZ01'
    header_len     4 bytes   uint32 LE — byte length of the JSON that follows
    header_json    header_len bytes, UTF-8 JSON:
        {
          "divisor": 127,
          "n_streamlines": 5735,
          "source_header": { ...original .tck header's CUSTOM fields... },
          "uuid": "..."   (only if the source .tck has a timestamp — see below)
        }
    then, per streamline, back to back with no padding:
        n_points   4 bytes   uint32
        [if n_points == 0: nothing further]
        start      12 bytes  3 x float32 (the first point, exact)
        Q          4 bytes   float32 (this streamline's own quantization unit)
        [if n_points >= 2: deltas, (n_points-1) x 3 bytes, each signed int8]

source_header carries the ORIGINAL file's custom header fields,
so the original .tck file can be reconstructed exactly, apart from 
quantization losses.

uuid identifies this streamline set to .dqz child data files (their
"parent" field). It is set to the source .tck's own `timestamp` header
field when there is one: MRtrix copies that timestamp into every .tsf
derived from the .tck, so tsf_to_dqz.py can name the parent from the
.tsf alone. With no timestamp, no uuid is written here; tsf_to_dqz.py
--parent-dqz inserts one when the first child is made. See dqz-format.md.
"""

import json
import struct
import numpy as np
import nibabel as nib
from nibabel.streamlines.header import Field
from nibabel.streamlines.tck import TckFile
from nibabel.streamlines.tractogram import Tractogram
from dipy.io.streamline import load_tractogram
from dipy.io.stateful_tractogram import Space

MAGIC = b'TCKDQZ01'
DIVISOR_MAX = 127  # the largest divisor that still guarantees every delta fits in signed int8

# Fields nibabel's own TckFile writer manages itself and regenerates
# fresh on every save (confirmed directly in TckFile._write_header's own
# exclude list) — stripped out before embedding a source header in the
# .dqz, and never re-supplied when writing a reconstructed .tck, since
# re-embedding a STALE value here would be actively wrong (e.g. a count
# that no longer matches), not just redundant.
_RESERVED_TCK_HEADER_KEYS = {
    Field.MAGIC_NUMBER, Field.NB_STREAMLINES, Field.ENDIANNESS,
    Field.VOXEL_TO_RASMM, 'count', 'datatype', 'file',
}


def _sanitize_header_for_json(header):
    """Keeps only genuinely CUSTOM fields from a raw TCK header dict —
    see _RESERVED_TCK_HEADER_KEYS — and converts whatever's left into
    JSON-safe types (bytes -> str, numpy arrays/scalars -> plain
    Python)."""
    out = {}
    for k, v in header.items():
        if k.startswith('_') or k in _RESERVED_TCK_HEADER_KEYS:
            continue
        if isinstance(v, bytes):
            v = v.decode('utf-8', errors='replace')
        elif isinstance(v, np.ndarray):
            v = v.tolist()
        elif isinstance(v, np.integer):
            v = int(v)
        elif isinstance(v, np.floating):
            v = float(v)
        out[k] = v
    return out


# ───────────────────── per-streamline quantization ─────────────────────

def quantize_streamline(pts, divisor=127):
    """Reduces one streamline to (start, Q, deltas, n_points, n_clip_events).
    See module docstring for exactly how these are computed and why they
    don't accumulate error."""
    if divisor > DIVISOR_MAX:
        raise ValueError(f"divisor must be <= {DIVISOR_MAX} to guarantee every delta fits in signed int8 (got {divisor})")

    pts = np.asarray(pts, dtype=np.float64)
    n = len(pts)
    if n == 0:
        return np.zeros(3), 0.0, np.zeros((0, 3), dtype=np.int8), 0, 0
    start = pts[0].copy()
    if n < 2:
        return start, 0.0, np.zeros((0, 3), dtype=np.int8), n, 0

    rel = pts - start
    seg_len = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    max_seg = seg_len.max()
    if max_seg < 1e-12:
        return start, 0.0, np.zeros((n - 1, 3), dtype=np.int8), n, 0

    Q = max_seg / divisor
    quantized_int = np.round(rel / Q).astype(np.int64)
    deltas = np.diff(quantized_int, axis=0)
    clipped = np.clip(deltas, -divisor, divisor)
    n_clip_events = int(np.sum(deltas != clipped))
    return start, float(Q), clipped.astype(np.int8), n, n_clip_events


def dequantize_streamline(start, Q, deltas, n_points):
    """Inverse of quantize_streamline. Exact (subject only to the
    one-time per-point rounding quantize_streamline already
    performed)."""
    if n_points == 0:
        return np.zeros((0, 3), dtype=np.float64)
    start = np.asarray(start, dtype=np.float64)
    if n_points < 2 or Q == 0.0:
        return np.tile(start, (n_points, 1))
    quantized_int = np.zeros((n_points, 3), dtype=np.int64)
    quantized_int[1:] = np.cumsum(deltas.astype(np.int64), axis=0)
    return start + quantized_int.astype(np.float64) * Q


# ───────────────────── file-level compression ─────────────────────

def _derive_output_path(in_path, out_path):
    """Auto-derives '<original filename>.dqz' if no out_path was given
    — the FULL original name, '.tck' included, stays intact; '.dqz' is
    only ever appended, never a replacement. Warns, rather than silently
    overriding, if the caller gave an explicit name that doesn't follow
    that '....tck.dqz' convention (see module docstring for why the
    naming matters)."""
    if out_path is None:
        return str(in_path) + '.dqz'
    out_path = str(out_path)
    if not out_path.lower().endswith('.tck.dqz'):
        import warnings
        warnings.warn(
            f"output path '{out_path}' doesn't follow the '<original>.tck.dqz' "
            "recommendation. DQZ is a compression layer on top of tck.",
            stacklevel=2,
        )
    return out_path


def compress_tractogram(in_path, out_path=None, divisor=127,
                         reference=None, debug=False, debug_out_path=None,
                         verbose=True):
    """Loads a .tck file and writes a quantized/delta-encoded '.dqz' file
    (see module docstring for the exact scheme, file format, and error
    bound).

    reference: dipy's load_tractogram requires SOME reference image for
    .tck even though TCK coordinates are already world-mm and don't
    actually need one for anything geometric — a small dummy identity-
    affine volume is used if none is given (same as tck_compress.py;
    verified there that coordinates come back byte-for-byte unchanged
    from a real .tck using this).

    debug: if True, ALSO reconstructs the just-written .dqz back into a
    real, loadable '<out_path>.debug.tck' and computes actual per-point
    reconstruction error, folding max/mean into the returned result.

    Returns a dict: streamline count, original point count, raw vs.
    compressed byte counts, reduction percentage, total clip-event count
    (should always be 0 — see module docstring), and, if debug=True,
    measured deviation stats.
    """
    in_path = str(in_path)
    out_path = _derive_output_path(in_path, out_path)

    if reference is None:
        reference = nib.Nifti1Image(np.zeros((2, 2, 2), dtype=np.uint8), affine=np.eye(4))

    sft = load_tractogram(in_path, reference, to_space=Space.RASMM, bbox_valid_check=False)
    orig_streamlines = list(sft.streamlines)

    # Raw header fetched separately via nibabel directly — dipy's
    # StatefulTractogram (used above for streamlines, per this project's
    # own established preference) doesn't expose the underlying file's
    # raw header dict at all, only its own space-attribute abstraction.
    raw_header = nib.streamlines.load(in_path).header
    source_header = _sanitize_header_for_json(raw_header)

    header_obj = {
        'divisor': divisor,
        'n_streamlines': len(orig_streamlines),
        'source_header': source_header,
    }
    timestamp = source_header.get('timestamp')
    if timestamp not in (None, ''):
        header_obj['uuid'] = str(timestamp).strip()
    header_bytes = json.dumps(header_obj).encode('utf-8')

    n_clip_total = 0
    orig_total_pts = 0

    with open(out_path, 'wb') as f:
        f.write(MAGIC)
        f.write(struct.pack('<I', len(header_bytes)))
        f.write(header_bytes)
        for s in orig_streamlines:
            s = np.asarray(s)
            start, Q, deltas, n, n_clip = quantize_streamline(s, divisor=divisor)
            n_clip_total += n_clip
            orig_total_pts += n

            f.write(struct.pack('<I', n))
            if n == 0:
                continue
            f.write(struct.pack('<3f', *start.astype(np.float32)))
            f.write(struct.pack('<f', Q))
            if n >= 2:
                f.write(deltas.tobytes())  # (n-1, 3) int8, C-contiguous

    import os
    raw_size = os.path.getsize(in_path)
    compressed_size = os.path.getsize(out_path)
    result = {
        'n_streamlines': len(orig_streamlines),
        'orig_points': orig_total_pts,
        'raw_bytes': raw_size,
        'compressed_bytes': compressed_size,
        'reduction_pct': 100.0 * (1 - compressed_size / raw_size) if raw_size else 0.0,
        'n_clip_events': n_clip_total,
    }

    if debug:
        if debug_out_path is None:
            debug_out_path = out_path + '.debug.tck'
        recon_result = reconstruct_tck(out_path, debug_out_path, verbose=False)
        max_deviation = 0.0
        sum_deviation = 0.0
        n_deviation_pts = 0
        for orig, recon in zip(orig_streamlines, recon_result['streamlines']):
            dev = np.linalg.norm(np.asarray(orig) - recon, axis=1)
            if len(dev):
                max_deviation = max(max_deviation, float(dev.max()))
                sum_deviation += float(dev.sum())
                n_deviation_pts += len(dev)
        result['debug_out_path'] = debug_out_path
        result['max_deviation_mm'] = max_deviation
        result['mean_deviation_mm'] = sum_deviation / n_deviation_pts if n_deviation_pts else 0.0

    if verbose:
        print(f"{in_path} -> {out_path}")
        print(f"  {result['n_streamlines']} streamlines, {result['orig_points']:,} points")
        print(f"  file size: {raw_size:,} -> {compressed_size:,} bytes ({result['reduction_pct']:.1f}% smaller)")
        if n_clip_total:
            print(f"  WARNING: {n_clip_total} delta component(s) had to be clipped to the "
                  f"[-{divisor},{divisor}] range — this should not normally happen (see module "
                  f"docstring); reconstruction error may exceed the theoretical bound at those points.")
        if debug:
            print(f"  debug reconstruction: {result['debug_out_path']}")
            print(f"  measured deviation (original vs. reconstructed): "
                  f"max {result['max_deviation_mm']:.6f}mm, mean {result['mean_deviation_mm']:.6f}mm")
    return result


def decompress_tractogram(path):
    """Reads a '.dqz' file back into (streamlines, header) — streamlines
    a list of (n,3) float64 arrays, header the parsed JSON dict (see
    module docstring for its shape). This is the general-purpose reader
    any consumer of this format needs, including a future JS port for
    the app's own loader — kept separate from reconstruct_tck so it's
    usable standalone (e.g. just inspecting the header, or working with
    streamlines in-memory without writing a .tck at all)."""
    with open(path, 'rb') as f:
        magic = f.read(8)
        if magic != MAGIC:
            raise ValueError(f"not a .dqz file (bad magic: {magic!r})")
        header_len = struct.unpack('<I', f.read(4))[0]
        header = json.loads(f.read(header_len).decode('utf-8'))
        n_streamlines = header['n_streamlines']
        streamlines = []
        for _ in range(n_streamlines):
            n = struct.unpack('<I', f.read(4))[0]
            if n == 0:
                streamlines.append(np.zeros((0, 3), dtype=np.float64))
                continue
            start = np.array(struct.unpack('<3f', f.read(12)), dtype=np.float64)
            Q = struct.unpack('<f', f.read(4))[0]
            if n >= 2:
                deltas = np.frombuffer(f.read((n - 1) * 3), dtype=np.int8).reshape(n - 1, 3)
            else:
                deltas = np.zeros((0, 3), dtype=np.int8)
            streamlines.append(dequantize_streamline(start, Q, deltas, n))
    return streamlines, header


def reconstruct_tck(dqz_path, out_tck_path=None, verbose=True):
    """Decompresses a '.dqz' file back into a real, standard .tck —
    geometry exact to within the scheme's own quantization error (see
    module docstring), and any custom fields the ORIGINAL source file's
    header carried (beyond nibabel's own auto-managed bookkeeping,
    stripped and restored via _sanitize_header_for_json /
    _RESERVED_TCK_HEADER_KEYS) restored too. This is the actual
    "give me my .tck back" entry point — compress_tractogram's debug
    mode calls this same function rather than duplicating the logic.

    out_tck_path: defaults to '<dqz_path with .dqz stripped>' (so
    'foo.tck.dqz' -> 'foo.tck').

    Returns a dict with 'streamlines' (the reconstructed list, for
    programmatic use without a second file read) and 'out_path'.
    """
    dqz_path = str(dqz_path)
    if out_tck_path is None:
        out_tck_path = dqz_path[:-len('.dqz')] if dqz_path.lower().endswith('.dqz') else dqz_path + '.tck'

    streamlines, header = decompress_tractogram(dqz_path)
    tractogram = Tractogram(streamlines=[s.astype('f4') for s in streamlines], affine_to_rasmm=np.eye(4))
    TckFile(tractogram, header=header.get('source_header', {})).save(out_tck_path)

    if verbose:
        print(f"{dqz_path} -> {out_tck_path}")
        print(f"  {len(streamlines)} streamlines reconstructed")
    return {'streamlines': streamlines, 'out_path': out_tck_path}


if __name__ == '__main__':
    import argparse
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='command', required=True)

    pc = sub.add_parser('compress', help='compress a .tck into a .dqz')
    pc.add_argument('input', help='input .tck file')
    pc.add_argument('output', nargs='?', default=None,
                     help="output .dqz file — default: '<input>.dqz'")
    pc.add_argument('--divisor', type=int, default=127,
                     help=f'quantization divisor, 1-{DIVISOR_MAX} (default 127 — the max that still fits signed int8)')
    pc.add_argument('--debug', action='store_true',
                     help='also write a companion <output>.debug.tck (a real, loadable .tck) '
                          'reconstructed from the compressed data, and report measured deviation stats')

    pr = sub.add_parser('reconstruct', help='decompress a .dqz back into a real .tck')
    pr.add_argument('input', help='input .dqz file')
    pr.add_argument('output', nargs='?', default=None,
                     help="output .tck file — default: '<input with .dqz stripped>'")

    args = p.parse_args()
    if args.command == 'compress':
        compress_tractogram(args.input, args.output, divisor=args.divisor, debug=args.debug)
    elif args.command == 'reconstruct':
        reconstruct_tck(args.input, args.output)
