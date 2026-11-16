import * as THREE from 'three';

export function buildEfficientSWCMesh(swcString) {
  const lines = swcString.split('\n');
  const nodes = new Map();
  
  // Storage for unique points
  const positions = [];
  const colors = [];
  
  // Maps SWC Node ID -> Index in the unique positions array
  const idToVertexIndex = new Map();

  // Color Map
  const typeColors = {
    1: [1.0, 0.0, 0.0], // Soma
    2: [1.0, 0.5, 0.0], // Axon
    3: [0.0, 0.7, 1.0], // Basal Dendrite
    4: [0.0, 1.0, 0.0], // Apical Dendrite
  };

  // 1. Parse and compile unique vertices
  let vertexCounter = 0;
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 7) continue;

    const id = parseInt(parts[0], 10);
    const type = parseInt(parts[1], 10);
    const x = parseFloat(parts[2]);
    const y = parseFloat(parts[3]);
    const z = parseFloat(parts[4]);
    const parentId = parseInt(parts[6], 10);

    // Push coordinates
    positions.push(x, y, z);
    
    // Push color
    const c = typeColors[type] || [0.7, 0.7, 0.7];
    colors.push(c[0], c[1], c[2]);

    // Track index matching
    nodes.set(id, parentId);
    idToVertexIndex.set(id, vertexCounter);
    vertexCounter++;
  }

  // 2. Build the structural index segment map (The "Jumps")
  const indices = [];
  for (const [id, parentId] of nodes.entries()) {
    // If it has a valid parent, draw a segment line from Parent to Child
    if (parentId !== -1 && idToVertexIndex.has(parentId)) {
      const currentVertexIdx = idToVertexIndex.get(id);
      const parentVertexIdx = idToVertexIndex.get(parentId);

      // Connect them
      indices.push(parentVertexIdx, currentVertexIdx);
    }
  }

  // 3. Package into Three.js BufferGeometry
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);

  // Use LineSegments instead of Line! LineSegments breaks up every 2 indices into isolated bars
  const material = new THREE.LineBasicMaterial({ vertexColors: true });
  const axonMesh = new THREE.LineSegments(geometry, material);

  return axonMesh;
}
