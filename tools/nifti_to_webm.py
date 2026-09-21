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
        return (norm*255.9999).astype(np.uint8), mn, mx


def rgb_to_uint8(data_rgb):
    """DEC data is already ~[0,1] and meaningfully scaled - no per-volume
    mn/mx windowing (that would corrupt the colour meaning), just quantize
    to 8 bits/channel. mn/mx are still reported in metadata for reference."""
    mn = float(np.nanmin(data_rgb))
    mx = float(np.nanmax(data_rgb))
    typed = np.round(np.clip(data_rgb, 0.0, 1.0) * 255.0).astype(np.uint8)
    return typed, mn, mx


#def write_frame_pngs_scalar(data_u8, out_dir, ny):
#    """Iterate coronal (Y) slices front-to-back (frame 0 = most anterior),
#    with each frame's row 0 = superior (top of image) and column 0 =
#    anatomical Right displayed on the left (radiological convention,
#    matches viewing the subject from the front)."""
#    from PIL import Image
#    for f in range(ny):
#        y_index = ny - 1 - f                     # Y flip: front-to-back order
#        tile = data_u8[::-1, y_index, ::-1].T     # X flip (col0=Right) + Z flip (row0=superior); (X,Z)->(Z,X)
#        Image.fromarray(tile, mode="L").save(
#            os.path.join(out_dir, f"frame_{f:05d}.png"))


def write_frame_pngs_rgb(data_u8, out_dir, ny):
    """Same axis convention as the scalar path, but keeping the channel
    axis intact: (X, Z, 3) -> (Z, X, 3)."""
    from PIL import Image
    for f in range(ny):
        y_index = ny - 1 - f
        tile = data_u8[::-1, y_index, ::-1, :].transpose(1, 0, 2)  # (X,Z,3) -> (Z,X,3)
        Image.fromarray(tile, mode="RGB").save(
            os.path.join(out_dir, f"frame_{f:05d}.png"))


def write_frame_pngs_scalar(data_u8, out_dir, ny):
    """For scalar (grayscale) volumes: isolates the quantized intensity
    into the GREEN channel of an otherwise-constant-zero RGB tile, then
    reuses write_frame_pngs_rgb() unchanged. Measured >2x smaller than
    duplicating the same data into all 3 channels (the old -pix_fmt gray
    approach, which ffmpeg/libvpx silently turn into gbrp anyway since
    neither VP9 nor most ffmpeg AV1 builds expose true monochrome) - and
    still plain GBRP (no YUV, no chroma matrix), which is the one format
    proven to decode correctly in both Firefox and Chromium/Brave.
    G specifically, not R or B: libvpx's rate control treats plane 0 -
    which is G in ffmpeg's own G,B,R gbrp plane order - with noticeably
    better quality/QP than planes 1-2, even though GBR content has no
    real luma/chroma relationship for that to be "correct" about;
    measured ~20% smaller than isolating into R or B instead.
    """
    import numpy as np
    rgb = np.zeros((*data_u8.shape, 3), dtype=np.uint8)
    rgb[..., 1] = data_u8  # G channel carries the real data; R, B stay 0
    write_frame_pngs_rgb(rgb, out_dir, ny)
    

def encode_webm(frame_dir, out_path, crf, fps, pix_fmt, lossless=False):
    cmd = [
        "ffmpeg", "-y",
        "-framerate", str(fps),
        "-i", os.path.join(frame_dir, "frame_%05d.png"),
        # Frames in frame_dir are now written as 3-channel RGB PNGs with
        # the real intensity data in the GREEN channel and red/blue held
        # constant at 0 (see the frame-writing code - needs updating to
        # match, see below) - NOT plain grayscale PNGs converted to gbrp
        # by ffmpeg, which would duplicate the same data into all 3
        # channels. Isolating to G instead of duplicating cut GBRP file
        # size by >2x in testing (measured: ~2.3x on a synthetic test),
        # and G specifically (not R or B) because libvpx's rate control
        # treats plane 0 (which is G in ffmpeg's own G,B,R gbrp ordering)
        # with better quality/QP than planes 1-2, even for GBR content
        # with no real luma/chroma relationship - confirmed empirically,
        # G was ~20% smaller than isolating into R or B.
        "-pix_fmt", "gbrp",
        "-color_range", "2",
        "-color_primaries", "1",
        "-color_trc", "1",
        "-colorspace", "1",
        #"-sws_flags", "spline+accurate_rnd+full_chroma_int",
        "-fps_mode", "passthrough",
        "-g", "30",
        "-c:v", "libvpx-vp9",
    ]
    if lossless:
        cmd += ["-lossless", "1"]
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
