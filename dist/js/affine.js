// ── affine.js ─────────────────────────────────────────────
// Affine math for 4×4 row-major matrices stored as 4x3 matrices, with 3x3 transformation part and translation part in last row

export function invertAffine(Ab) {
  const A = [Ab[0],Ab[1],Ab[2]]
  const b = Ab[3]
  const a00=A[0][0],a01=A[0][1],a02=A[0][2],tx=b[0];
  const a10=A[1][0],a11=A[1][1],a12=A[1][2],ty=b[1];
  const a20=A[2][0],a21=A[2][1],a22=A[2][2],tz=b[2];
  const c00= a11*a22-a12*a21, c01=-(a10*a22-a12*a20), c02= a10*a21-a11*a20;
  const c10=-(a01*a22-a02*a21), c11= a00*a22-a02*a20, c12=-(a00*a21-a01*a20);
  const c20= a01*a12-a02*a11, c21=-(a00*a12-a02*a10), c22= a00*a11-a01*a10;
  const det = a00*c00 + a01*c01 + a02*c02;
  const i00=c00/det, i01=c10/det, i02=c20/det;
  const i10=c01/det, i11=c11/det, i12=c21/det;
  const i20=c02/det, i21=c12/det, i22=c22/det;
  return [
    [i00, i01, i02],
    [i10, i11, i12],
    [i20, i21, i22],
    [
	  -(i00*tx+i01*ty+i02*tz),
	  -(i10*tx+i11*ty+i12*tz),
	  -(i20*tx+i21*ty+i22*tz)
    ]
  ];
}

// Apply 3x3 or 4x3 matrix to a 3-vector
export function mat3mulVec(Ab, v) {
  const A = [Ab[0],Ab[1],Ab[2]]
  const b = Ab.length>3 ? Ab[3] : [0,0,0]
  return [
    A[0][0]*v[0] + A[0][1]*v[1] + A[0][2]*v[2] + b[0],
    A[1][0]*v[0] + A[1][1]*v[1] + A[1][2]*v[2] + b[1],
    A[2][0]*v[0] + A[2][1]*v[1] + A[2][2]*v[2] + b[2]
  ]
}

export function absVec(v) {
	return v.map(Math.abs)
}

export function matMul(A, B) {
  const rowsA = A.length, colsA = A[0].length, colsB = B[0].length;
  return Array.from({ length: rowsA }, (_, r) =>
    Array.from({ length: colsB }, (_, c) => {
      let sum = 0;
      for (let k = 0; k < colsA; k++) sum += A[r][k] * B[k][c];
      return sum;
    })
  );
}

export function voxToRas(Ab, v) {
  return mat3mulVec(Ab, v)
}

export function rasToVox(invAb, r) {
  return mat3mulVec(invAb, r);
}

// Build rotation matrix from pitch (X), yaw (Y), roll (Z) in radians
// Order: Rz * Ry * Rx  (roll applied first, then yaw, then pitch)
export function eulerToMat3(pitch, yaw, roll) {
  const cp=Math.cos(pitch), sp=Math.sin(pitch);
  const cy=Math.cos(yaw),   sy=Math.sin(yaw);
  const cr=Math.cos(roll),  sr=Math.sin(roll);
  // Rz*Ry*Rx
  return [
    [ cy*cr,             cy*sr,            -sy    ],
    [ sp*sy*cr - cp*sr,  sp*sy*sr + cp*cr,  sp*cy ],
    [ cp*sy*cr + sp*sr,  cp*sy*sr - sp*cr,  cp*cy ],
  ];
}

/**
 * Decomposes a 3x3 affine matrix A (row-major nested array) and translation b
 * into permutation P, pixel-size scaling S, residual shear/rotation K.
 * A = P * S * K  (approximately, for typical NIfTI affines)
 *
 * @param {number[][]} A - 3x3 nested row-major array
 * @param {number[]}   b - [tx, ty, tz] translation
 * @returns {{ P, S, K, b, vox_size }}
 */
export function decomposeAffine(Ab) {
  const A = [Ab[0],Ab[1],Ab[2]]
  const b = Ab[3]
	
  // Sort voxel columns by confidence so strongest axis gets first pick
  const order = [0,1,2].sort((a,bx) =>
    Math.max(...[0,1,2].map(r => Math.abs(A[r][bx]))) -
    Math.max(...[0,1,2].map(r => Math.abs(A[r][a])))
  );
  const P = [[0,0,0],[0,0,0],[0,0,0]];
  const rowAssigned = [false,false,false];
  for (const col of order) {
    let maxVal=-1, chosenRow=-1, sign=1;
    for (let row=0; row<3; row++) {
      if (rowAssigned[row]) continue;
      const absVal = Math.abs(A[row][col]);
      if (absVal > maxVal) {
        maxVal=absVal; chosenRow=row;
        sign = A[row][col] >= 0 ? 1 : -1;
      }
    }
    if (chosenRow === -1)
      chosenRow = [0,1,2].find(r => !rowAssigned[r]);
    P[chosenRow][col] = sign;
    rowAssigned[chosenRow] = true;
  }

  // D = P^T * A  (P is orthogonal so P^T = P^-1)
  const D = [[0,0,0],[0,0,0],[0,0,0]];
  for (let r=0; r<3; r++)
    for (let c=0; c<3; c++)
      D[r][c] = P[0][r]*A[0][c] + P[1][r]*A[1][c] + P[2][r]*A[2][c];

  // S: diagonal pixel sizes from D diagonal
  const dx = Math.abs(D[0][0]) || 1;
  const dy = Math.abs(D[1][1]) || 1;
  const dz = Math.abs(D[2][2]) || 1;
  const S = [[dx,0,0],[0,dy,0],[0,0,dz]];

  // K = S^-1 * D  (residual shear/rotation, unit diagonal)
  const K = [
    [D[0][0]/dx, D[0][1]/dx, D[0][2]/dx],
    [D[1][0]/dy, D[1][1]/dy, D[1][2]/dy],
    [D[2][0]/dz, D[2][1]/dz, D[2][2]/dz],
  ];

  return { P, S, K, b, vox_size: [dx, dy, dz] };
}


/**
 * Decomposes a 3x3 affine matrix A (row-major nested array) and translation b
 * into residual shear/rotation K, pixel-size scaling S, permutation P.
 * A = K * S * P
 * 
 * If pixdims are provided, use them to compute S.
 *
 * @param {number[][]} A - 3x3 nested row-major array
 * @param {number[]}   b - [tx, ty, tz] translation
 * @returns {{ P, S, K, b, vox_size }}
 */
export function decomposeAffineKSP(Ab,nifti_voxel_size) {
  const A = [Ab[0], Ab[1], Ab[2]];
  const b = Ab[3];
    
  // 1. Sort RAS rows by confidence so the strongest spatial axis gets first pick
  const order = [0, 1, 2].sort((a, bx) =>
    Math.max(...[0, 1, 2].map(c => Math.abs(A[bx][c]))) -
    Math.max(...[0, 1, 2].map(c => Math.abs(A[a][c])))
  );

  const P = [[0,0,0], [0,0,0], [0,0,0]];
  const colAssigned = [false, false, false];

  // Map each spatial row to its dominant voxel column
  for (const row of order) {
    let maxVal = -1, chosenCol = -1, sign = 1;
    for (let col = 0; col < 3; col++) {
      if (colAssigned[col]) continue;
      const absVal = Math.abs(A[row][col]);
      if (absVal > maxVal) {
        maxVal = absVal; chosenCol = col;
        sign = A[row][col] >= 0 ? 1 : -1;
      }
    }
    if (chosenCol === -1)
      chosenCol = [0, 1, 2].find(c => !colAssigned[c]);
    
    P[row][chosenCol] = sign;
    colAssigned[chosenCol] = true;
  }

  // 2. D = A * P^T  (Since P is on the right, D = A * P^-1)
  const D = [[0,0,0], [0,0,0], [0,0,0]];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      // Matrix multiplication: A * P^T
      D[r][c] = A[r][0]*P[c][0] + A[r][1]*P[c][1] + A[r][2]*P[c][2];
    }
  }

  // 3. S: Compute the Euclidean length of each column vector in D
  const dx = Math.sqrt(D[0][0]*D[0][0] + D[1][0]*D[1][0] + D[2][0]*D[2][0]) || 1;
  const dy = Math.sqrt(D[0][1]*D[0][1] + D[1][1]*D[1][1] + D[2][1]*D[2][1]) || 1;
  const dz = Math.sqrt(D[0][2]*D[0][2] + D[1][2]*D[1][2] + D[2][2]*D[2][2]) || 1;
  const S = [[dx, 0, 0], [0, dy, 0], [0, 0, dz]];
  
  // 4. K = D * S^-1 (Residual shear/rotation in RAS space)
  const K = [
    [D[0][0]/dx, D[0][1]/dy, D[0][2]/dz],
    [D[1][0]/dx, D[1][1]/dy, D[1][2]/dz],
    [D[2][0]/dx, D[2][1]/dy, D[2][2]/dz],
  ];

  // A === K * S * P
  return { K, S, P, b };
}
