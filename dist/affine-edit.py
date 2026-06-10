#!/usr/bin/env python3
"""
set_affine.py  –  inspect or replace the affine of a NIfTI file (nibabel).

Usage:
  python set_affine.py info input.nii.gz
  python set_affine.py copy input.nii.gz donor.nii.gz output.nii.gz
  python set_affine.py set  input.nii.gz output.nii.gz  r00 r01 r02 tx  r10 r11 r12 ty  r20 r21 r22 tz
  python set_affine.py flipx input.nii.gz output.nii.gz   # negate first column (flip R-L)
"""

import sys
import numpy as np
import nibabel as nib

def info(path):
    img = nib.load(path)
    print(f"Shape : {img.shape}")
    print(f"Dtype : {img.get_data_dtype()}")
    print(f"Zooms : {img.header.get_zooms()}")
    print(f"sform_code: {int(img.header['sform_code'])}")
    print(f"qform_code: {int(img.header['qform_code'])}")
    print("sform affine:")
    print(np.array2string(img.get_sform(), precision=6, suppress_small=True))
    print("qform affine:")
    print(np.array2string(img.get_qform(), precision=6, suppress_small=True))
    print(f"det(rotation): {np.linalg.det(img.affine[:3,:3]):.4f}")

def save(img, new_affine, out_path):
    # Set both sform and qform to the new affine, code=1 (scanner RAS)
    img.set_sform(new_affine, code=1)
    img.set_qform(new_affine, code=1)
    nib.save(img, out_path)
    print(f"Saved {out_path}")
    print("New affine:")
    print(np.array2string(new_affine, precision=6, suppress_small=True))
    print(f"det(rotation): {np.linalg.det(new_affine[:3,:3]):.4f}")

def cmd_copy(src, donor, out):
    img    = nib.load(src)
    d_img  = nib.load(donor)
    save(img, d_img.affine.copy(), out)

def cmd_set(src, out, values):
    img = nib.load(src)
    v = [float(x) for x in values]
    if len(v) != 12:
        sys.exit("Need exactly 12 values: r00..r22 tx ty tz (row-major, no last row)")
    new_affine = np.array([
        [v[0],  v[1],  v[2],  v[3]],
        [v[4],  v[5],  v[6],  v[7]],
        [v[8],  v[9],  v[10], v[11]],
        [0,     0,     0,     1   ],
    ], dtype=np.float64)
    save(img, new_affine, out)

def cmd_flipx(src, out):
    img = nib.load(src)
    new_affine = img.affine.copy()
    new_affine[:, 0] *= -1   # negate first column → flip R-L axis
    save(img, new_affine, out)

cmds = {'info':2, 'copy':3, 'set':3, 'flipx':2}
if len(sys.argv) < 2 or sys.argv[1] not in cmds:
    print(__doc__); sys.exit(1)

cmd = sys.argv[1]
args = sys.argv[2:]

if   cmd == 'info':  info(args[0])
elif cmd == 'copy':  cmd_copy(args[0], args[1], args[2])
elif cmd == 'set':   cmd_set(args[0], args[1], args[2:])
elif cmd == 'flipx': cmd_flipx(args[0], args[1])
