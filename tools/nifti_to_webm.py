import sys
import os
import json
import shutil
import subprocess
import tempfile
import numpy as np
import nibabel as nib

CRF = 10  # chosen sweet spot from prior scalar-volume eval
FPS = 10  # arbitrary - no real playback semantics, just a container requirement


def flip_axis_in_affine(Ab, axis, n):
    """Ab: list of 4 rows [x_contrib, y_contrib, z_contrib, translation],
    each a 3-vector of world-space contributions. Returns a new Ab
    reflecting a flip of voxel axis `axis` (size n) - i.e.
    new_index = (n - 1) - old_index along that axis."""
    Ab = [list(row) for row in Ab]  # copy
    col = Ab[axis]
    Ab[3] = [Ab[3][i] + col[i] * (n - 1) for i in range(3)]
    Ab[axis] = [-v for v in col]
    return Ab


def build_affine_rows(affine):
    return [
        [float(affine[0, 0]), float(affine[0, 1]), float(affine[0, 2])],
        [float(affine[1, 0]), float(affine[1, 1]), float(affine[1, 2])],
        [float(affine[2, 0]), float(affine[2, 1]), float(affine[2, 2])],
        [float(affine[0, 3]), float(affine[1, 3]), float(affine[2, 3])],
    ]


# Full-scale value for integer numpy dtypes, used to normalize a plain
# integer-typed DEC/colour volume into [0,1] - mirrors integerRangeMax()
# in volume-io.js. Returns None for float dtypes (assumed already ~[0,1]).
def integer_range_max(dtype):
    mapping = {
        np.dtype(np.uint8):  255,
        np.dtype(np.int8):   127,
        np.dtype(np.int16):  32767,
        np.dtype(np.uint16): 65535,
        np.dtype(np.int32):  2147483647,
    }
    return mapping.get(dtype, None)


def detect_channels(data, header):
    """Returns (channels, kind). kind is 'packed' for DT_RGB24/DT_RGBA32
    (structured dtype), 'vector' for a plain 4D image with exactly 3
    volumes along dim4 (MRtrix/mrview DEC convention, e.g.
    `tensor2metric -vector -modulate FA`), or None for a normal scalar
    volume."""
    dtype = header.get_data_dtype()
    if dtype.names:  # packed RGB24 ('R','G','B') / RGBA32 (+'A')
        return 3, 'packed'
    if data.ndim == 4 and data.shape[3] == 3:
        return 3, 'vector'
    return 1, None


def load_scalar(data):
    if data.ndim > 3:
        data = data[..., 0]
    return data


def load_dec_rgb(data, header, kind):
    """Returns an (X, Y, Z, 3) float array in [0, 1] - no mn/mx windowing,
    matching the 'already meaningfully scaled' convention in volume-io.js."""
    if kind == 'packed':
        # Structured dtype with 'R','G','B' (+ optionally 'A', discarded).
        rgb = np.stack([data['R'], data['G'], data['B']], axis=-1).astype(np.float32) / 255.0
        return rgb
    else:  # 'vector'
        int_max = integer_range_max(header.get_data_dtype())
        vol = data[..., :3].astype(np.float32)
        if int_max is not None:
            vol = vol / int_max
        # abs(): eigenvector sign is arbitrary and shouldn't be clamped to
        # 0 - same reasoning as the matching comment in volume-io.js.
        return np.abs(vol)


def normalize_scalar_uint8(data, categorical=False):
    if categorical:
        flat = data.reshape(-1)
        mn, mx = float(np.min(flat)), float(np.max(flat))
        typed = data.astype(np.uint8 if mx <= 255 else np.uint16)
        if typed.dtype != np.uint8:
            raise ValueError(
                f"Categorical volume max value {mx} exceeds uint8 range; "
                "8-bit video encoding would truncate labels. Handle "
                "separately (e.g. keep categorical volumes as a lossless "
                "PNG/NIfTI sidecar rather than video)."
            )
        return typed, mn, mx
    else:
        flat = data.astype(np.float32).reshape(-1)
        mn, mx = float(np.nanmin(flat)), float(np.nanmax(flat))
        rng = (mx - mn) if (mx - mn) != 0 else 1.0
        norm = np.clip((data.astype(np.float32) - mn) / rng, 0.0, 1.0)
        return np.round(norm * 255.0).astype(np.uint8), mn, mx


def rgb_to_uint8(data_rgb):
    """DEC data is already ~[0,1] and meaningfully scaled - no per-volume
    mn/mx windowing (that would corrupt the colour meaning), just quantize
    to 8 bits/channel. mn/mx are still reported in metadata for reference."""
    mn = float(np.nanmin(data_rgb))
    mx = float(np.nanmax(data_rgb))
    typed = np.round(np.clip(data_rgb, 0.0, 1.0) * 255.0).astype(np.uint8)
    return typed, mn, mx


def write_frame_pngs_scalar(data_u8, out_dir, ny):
    """Iterate coronal (Y) slices front-to-back (frame 0 = most anterior),
    with each frame's row 0 = superior (top of image) and column 0 =
    anatomical Right displayed on the left (radiological convention,
    matches viewing the subject from the front)."""
    from PIL import Image
    for f in range(ny):
        y_index = ny - 1 - f                     # Y flip: front-to-back order
        tile = data_u8[::-1, y_index, ::-1].T     # X flip (col0=Right) + Z flip (row0=superior); (X,Z)->(Z,X)
        Image.fromarray(tile, mode="L").save(
            os.path.join(out_dir, f"frame_{f:05d}.png"))


def write_frame_pngs_rgb(data_u8, out_dir, ny):
    """Same axis convention as the scalar path, but keeping the channel
    axis intact: (X, Z, 3) -> (Z, X, 3)."""
    from PIL import Image
    for f in range(ny):
        y_index = ny - 1 - f
        tile = data_u8[::-1, y_index, ::-1, :].transpose(1, 0, 2)  # (X,Z,3) -> (Z,X,3)
        Image.fromarray(tile, mode="RGB").save(
            os.path.join(out_dir, f"frame_{f:05d}.png"))


def encode_webm(frame_dir, out_path, crf, fps, pix_fmt="yuv420p", lossless=False):
    cmd = [
        "ffmpeg", "-y",
        "-framerate", str(fps),
        "-i", os.path.join(frame_dir, "frame_%05d.png"),
        # Force full-range (0-255) explicitly at the swscale conversion
        # step AND tag the output as full-range. Without this, ffmpeg
        # commonly defaults yuv420p to "limited"/"tv" range (16-235) even
        # for a genuinely full-range (0-255) source - an implicit rescale
        # on encode and its inverse on decode, a real lossy value
        # transform that happens BEFORE/AFTER VP9's own (exact, even at
        # lossless) entropy coding. Diagnosed via: diff=1 between an
        # original PNG frame and one ffmpeg-extracted from a lossless
        # webm - true lossless coding can't produce that on its own, so
        # the discrepancy had to come from a value transform outside the
        # coder itself, and unintended range conversion is the standard
        # cause of exactly this signature.
        "-vf", f"scale=in_range=full:out_range=full,format={pix_fmt}",
        "-color_range", "pc",  # tag output as full-range (not just convert to it)
        # Force an exact 1:1 input-frame-to-output-frame mapping. Without
        # this, ffmpeg's default frame-rate reconciliation (-fps_mode
        # auto) is free to duplicate or drop frames to resolve timestamp
        # rounding against the encoder's internal timebase - even when
        # fed a clean, evenly-spaced PNG sequence. Confirmed via: many
        # captured frames in the browser turning out to be pixel-identical
        # to a neighbor - i.e. some coronal Y-positions never got their
        # own distinct encoded frame at all, which is exactly what
        # produced the "terraced" look in orthogonal (sagittal/axial)
        # views while looking fine within any single coronal slice.
        "-fps_mode", "passthrough",
        # Explicit keyframe interval. Without this, libvpx-vp9's default
        # (sparse) keyframe spacing means seeking to an arbitrary frame
        # requires redecoding from a distant keyframe forward - this is
        # what made per-frame seeking (needed below to avoid a proven
        # browser-side frame-duplication race in sequential playback
        # capture) take minutes instead of seconds. A keyframe every 30
        # frames bounds worst-case see  k cost to ~30 predicted-frame
        # decodes, a small cost against inter-frame compression within
        # each 30-frame GOP.
        "-g", "20",
        "-c:v", "libvpx-vp9",
    ]
    if lossless:
        cmd += ["-lossless", "1"]  # mutually exclusive with -crf
    else:
        cmd += ["-b:v", "0", "-crf", str(crf)]
    cmd.append(out_path)

    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0:
        print("FFMPEG ENCODE ERROR:\n", res.stderr[-2000:])
        res.check_returncode()


def export_to_webm(input_path, output_webm, categorical=False, crf=CRF, fps=FPS,
                    yuv444=False, lossless=False):
    if shutil.which("ffmpeg") is None:
        print("ffmpeg not found on PATH - install it first (e.g. via mamba: "
              "mamba install -c conda-forge ffmpeg)")
        sys.exit(1)

    img = nib.load(input_path)
    canon_img = nib.as_closest_canonical(img)  # reorders spatial axes to RAS, no resampling
    header = canon_img.header

    raw_data = np.asanyarray(canon_img.dataobj)
    channels, kind = detect_channels(raw_data, header)

    if channels == 3 and categorical:
        raise ValueError("--categorical is not meaningful for a DEC/colour "
                          "(3-channel) volume; it's for integer label maps.")

    if channels == 3:
        print(f"Detected 3-channel DEC/colour volume (kind={kind}); "
              "no mn/mx windowing will be applied.")
        data_rgb = load_dec_rgb(raw_data, header, kind)  # (X, Y, Z, 3)
        nx, ny, nz = data_rgb.shape[:3]
        data_u8, mn, mx = rgb_to_uint8(data_rgb)
        frame_writer = write_frame_pngs_rgb
    else:
        data = load_scalar(raw_data)  # (X, Y, Z)
        nx, ny, nz = data.shape
        data_u8, mn, mx = normalize_scalar_uint8(data, categorical=categorical)
        frame_writer = write_frame_pngs_scalar

    vox_mm = [float(x) for x in header.get_zooms()[:3]]
    Ab = build_affine_rows(canon_img.affine)

    # Apply the same flips to the affine as we apply to the data below, so
    # the sidecar metadata matches the actual voxel arrangement in the
    # video, not the pre-flip RAS arrangement. Purely spatial - unaffected
    # by whether this is a scalar or 3-channel volume.
    Ab = flip_axis_in_affine(Ab, axis=0, n=nx)  # col0 = anatomical Right
    Ab = flip_axis_in_affine(Ab, axis=1, n=ny)  # front-to-back frame order
    Ab = flip_axis_in_affine(Ab, axis=2, n=nz)  # row 0 = superior

    pix_fmt = "yuv444p" if yuv444 else "yuv420p"

    with tempfile.TemporaryDirectory() as frame_dir:
        frame_writer(data_u8, frame_dir, ny)
        encode_webm(frame_dir, output_webm, crf=crf, fps=fps, pix_fmt=pix_fmt, lossless=lossless)

    meta = {
        "shape": [nx, ny, nz],
        "channels": channels,
        "frame_order": "coronal, front_to_back (frame 0 = most anterior)",
        "frame_layout": "row0=superior, col0=anatomical_right (radiological convention)",
        "vox_mm": vox_mm,
        "Ab": Ab,
        "mn": mn,
        "mx": mx,
        "categorical": categorical,
        "codec": "vp9",
        "pix_fmt": pix_fmt,
        "lossless": lossless,
        "crf": None if lossless else crf,
    }
    meta_path = output_webm + ".json"
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    print(f"Successfully generated: {output_webm}")
    print(f"Metadata written to: {meta_path}")


if __name__ == "__main__":
    is_cat = "--categorical" in sys.argv
    yuv444 = "--yuv444" in sys.argv
    lossless = "--lossless" in sys.argv
    args = [a for a in sys.argv[1:] if a not in ("--categorical", "--yuv444", "--lossless")]
    if len(args) < 2:
        print("Usage: python nifti_to_webm.py <input.nii.gz> <output.webm> "
              "[--categorical] [--yuv444] [--lossless]")
        sys.exit(1)
    export_to_webm(args[0], args[1], categorical=is_cat, yuv444=yuv444, lossless=lossless)
