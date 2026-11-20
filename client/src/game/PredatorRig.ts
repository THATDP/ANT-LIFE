import * as THREE from 'three';
import type { PredatorState } from '../../../shared/src/types.js';

export class PredatorRig {
  readonly group = new THREE.Group();
  private readonly legs: Array<{ a: THREE.Mesh; b: THREE.Mesh; side: number; index: number; phase: number }> = [];
  private readonly body: THREE.Group;
  private readonly redEyes: THREE.Mesh[] = [];

  constructor(kind: PredatorState['kind']) {
    this.group.name = `predator-${kind}`;
    this.body = new THREE.Group();
    this.group.add(this.body);
    const shell = new THREE.MeshPhysicalMaterial({ color: kind === 'spider' ? '#332834' : '#273638', roughness: 0.29, metalness: 0.27, clearcoat: 0.9 });
    const shellAccent = new THREE.MeshPhysicalMaterial({ color: kind === 'spider' ? '#74413f' : '#546f54', roughness: 0.4, metalness: 0.13, clearcoat: 0.6 });
    const legsMaterial = new THREE.MeshStandardMaterial({ color: '#242324', roughness: 0.52 });
    const bodyGeometry = new THREE.SphereGeometry(1, 16, 12);
    const abdomen = new THREE.Mesh(bodyGeometry, shell);
    abdomen.position.set(0, 0.37, -0.18);
    abdomen.scale.set(kind === 'spider' ? 0.48 : 0.58, kind === 'spider' ? 0.36 : 0.43, kind === 'spider' ? 0.61 : 0.54);
    this.body.add(abdomen);
    const head = new THREE.Mesh(kind === 'spider' ? new THREE.SphereGeometry(0.3, 14, 11) : new THREE.SphereGeometry(0.4, 14, 11), shellAccent);
    head.position.set(0, 0.34, 0.36);
    head.scale.set(1, 0.82, 0.9);
    this.body.add(head);
    if (kind === 'beetle') {
      const wingSeam = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.025, 6, 24), new THREE.MeshStandardMaterial({ color: '#9aac7b', roughness: 0.65 }));
      wingSeam.position.set(0, 0.59, -0.16);
      wingSeam.rotation.x = Math.PI / 2;
      this.body.add(wingSeam);
    } else {
      const eyeMaterial = new THREE.MeshBasicMaterial({ color: '#e77263' });
      for (const side of [-1, 1]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), eyeMaterial);
        eye.position.set(side * 0.21, 0.42, 0.54);
        this.body.add(eye);
        this.redEyes.push(eye);
      }
    }
    const count = kind === 'spider' ? 4 : 3;
    const segmentGeometry = new THREE.CylinderGeometry(0.035, 0.055, 1, 7);
    for (let index = 0; index < count; index += 1) {
      for (const side of [-1, 1]) {
        const a = new THREE.Mesh(segmentGeometry, legsMaterial);
        const b = new THREE.Mesh(segmentGeometry, legsMaterial);
        a.castShadow = b.castShadow = true;
        this.body.add(a, b);
        this.legs.push({ a, b, side, index, phase: (index % 2 ? Math.PI : 0) + (side > 0 ? Math.PI : 0) });
      }
    }
    this.animate(0, 0);
  }

  setTarget(pos: { x: number; y: number; z: number }, yaw: number): void {
    this.group.position.lerp(new THREE.Vector3(pos.x, pos.y, pos.z), 0.28);
    this.group.rotation.y = THREE.MathUtils.damp(this.group.rotation.y, yaw, 8, 1 / 60);
  }

  animate(time: number, movement: number): void {
    this.body.position.y = Math.sin(time * 4) * (movement > 0.02 ? 0.03 : 0.012);
    for (const leg of this.legs) {
      const phase = time * 7 + leg.phase;
      const stride = Math.sin(phase) * (0.16 + movement * 0.05);
      const lift = Math.max(0, Math.cos(phase)) * 0.11;
      const zBase = (leg.index - (this.legs.length > 6 ? 1.5 : 1)) * 0.19;
      const hip = new THREE.Vector3(leg.side * 0.2, 0.31, zBase);
      const knee = new THREE.Vector3(leg.side * (0.43 + leg.index * 0.025), 0.2 + lift * 0.35, zBase + stride * 0.55 + (leg.index - 1) * 0.12);
      const foot = new THREE.Vector3(leg.side * (0.66 + leg.index * 0.04), 0.035 + lift, zBase + stride + (leg.index - 1) * 0.21);
      placeSegment(leg.a, hip, knee);
      placeSegment(leg.b, knee, foot);
    }
  }
}

function placeSegment(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3): void {
  const direction = to.clone().sub(from);
  const length = direction.length();
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  mesh.scale.set(1, Math.max(0.05, length), 1);
}
