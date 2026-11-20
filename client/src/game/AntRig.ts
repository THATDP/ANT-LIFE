import * as THREE from 'three';
import type { AgentRole, AgentState, PlayerState } from '../../../shared/src/types.js';

const sphereGeometry = new THREE.SphereGeometry(1, 16, 12);
const legGeometry = new THREE.CylinderGeometry(0.034, 0.046, 1, 7, 1, false);
const antennaGeometry = new THREE.CylinderGeometry(0.018, 0.025, 1, 6, 1, false);
const roles: Record<AgentRole, { shell: string; highlight: string }> = {
  worker: { shell: '#783c26', highlight: '#b96334' },
  soldier: { shell: '#392f34', highlight: '#aa5637' },
  scout: { shell: '#9b482b', highlight: '#e28848' },
  digger: { shell: '#60432d', highlight: '#a46b3a' },
  nurse: { shell: '#783c42', highlight: '#d17d72' },
};

export class AntRig {
  readonly group = new THREE.Group();
  private readonly shell: THREE.MeshPhysicalMaterial;
  private readonly thoraxMaterial: THREE.MeshPhysicalMaterial;
  private readonly legMaterial: THREE.MeshStandardMaterial;
  private readonly head: THREE.Group;
  private readonly abdomen: THREE.Mesh;
  private readonly legs: Array<{ upper: THREE.Mesh; lower: THREE.Mesh; side: number; row: number; phase: number }> = [];
  private readonly antennae: Array<{ mesh: THREE.Mesh; side: number; phase: number }> = [];
  private readonly cargo: THREE.Mesh;
  private readonly body: THREE.Group;
  private readonly label: string;
  private wobble = 0;

  constructor(role: AgentRole = 'worker', private readonly scale = 1, customColor?: string, label = 'ant') {
    this.label = label;
    const palette = roles[role];
    this.shell = new THREE.MeshPhysicalMaterial({ color: customColor ?? palette.shell, roughness: 0.36, metalness: 0.12, clearcoat: 0.62, clearcoatRoughness: 0.38 });
    this.thoraxMaterial = new THREE.MeshPhysicalMaterial({ color: palette.highlight, roughness: 0.42, metalness: 0.08, clearcoat: 0.45 });
    this.legMaterial = new THREE.MeshStandardMaterial({ color: '#382b29', roughness: 0.65 });
    this.group.name = label;
    this.group.scale.setScalar(scale);
    this.body = new THREE.Group();
    this.group.add(this.body);

    this.abdomen = this.part(sphereGeometry, this.shell, { x: 0, y: 0.34, z: -0.29 }, { x: 0.27, y: 0.22, z: 0.34 });
    this.part(sphereGeometry, this.thoraxMaterial, { x: 0, y: 0.35, z: 0.08 }, { x: 0.17, y: 0.16, z: 0.23 });
    this.part(sphereGeometry, this.shell, { x: 0, y: 0.35, z: -0.055 }, { x: 0.11, y: 0.11, z: 0.16 });

    this.head = new THREE.Group();
    this.head.position.set(0, 0.39, 0.37);
    this.body.add(this.head);
    this.part(sphereGeometry, this.shell, { x: 0, y: 0, z: 0.02 }, { x: 0.225, y: 0.205, z: 0.23 }, this.head);
    const eyeMaterial = new THREE.MeshPhysicalMaterial({ color: '#120f10', roughness: 0.12, metalness: 0.22, clearcoat: 1 });
    this.part(sphereGeometry, eyeMaterial, { x: -0.174, y: 0.053, z: 0.118 }, { x: 0.061, y: 0.071, z: 0.06 }, this.head);
    this.part(sphereGeometry, eyeMaterial, { x: 0.174, y: 0.053, z: 0.118 }, { x: 0.061, y: 0.071, z: 0.06 }, this.head);

    const mandibleGeometry = new THREE.ConeGeometry(0.055, 0.18, 7, 1);
    for (const side of [-1, 1]) {
      const mandible = new THREE.Mesh(mandibleGeometry, this.legMaterial);
      mandible.position.set(side * 0.067, -0.06, 0.21);
      mandible.rotation.x = Math.PI * 0.43;
      mandible.rotation.z = side * -0.28;
      this.head.add(mandible);

      const antenna = new THREE.Mesh(antennaGeometry, this.thoraxMaterial);
      antenna.castShadow = true;
      this.head.add(antenna);
      this.antennae.push({ mesh: antenna, side, phase: side * 1.5 });
    }

    for (let row = 0; row < 3; row += 1) {
      for (const side of [-1, 1]) {
        const upper = new THREE.Mesh(legGeometry, this.legMaterial);
        const lower = new THREE.Mesh(legGeometry, this.legMaterial);
        upper.castShadow = lower.castShadow = true;
        this.body.add(upper, lower);
        this.legs.push({ upper, lower, side, row, phase: (row % 2 === 0 ? 0 : Math.PI) + (side < 0 ? Math.PI : 0) });
      }
    }

    const cargoMaterial = new THREE.MeshStandardMaterial({ color: '#e6bd68', roughness: 0.62 });
    this.cargo = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), cargoMaterial);
    this.cargo.position.set(0, 0.61, -0.15);
    this.cargo.castShadow = true;
    this.body.add(this.cargo);
    this.cargo.visible = false;
    this.animate(0, false, false);
  }

  setTarget(pos: { x: number; y: number; z: number }, yaw: number, immediate = false): void {
    if (immediate) {
      this.group.position.set(pos.x, pos.y, pos.z);
      this.group.rotation.y = yaw;
      return;
    }
    this.group.position.lerp(new THREE.Vector3(pos.x, pos.y, pos.z), 0.34);
    this.group.rotation.y = THREE.MathUtils.damp(this.group.rotation.y, yaw, 12, 1 / 60);
  }

  animate(time: number, moving: boolean, carrying: boolean): void {
    this.cargo.visible = carrying;
    const gait = moving ? Math.sin(time * 11 + this.wobble) : Math.sin(time * 1.8) * 0.08;
    this.body.position.y = Math.sin(time * (moving ? 18 : 2.4)) * (moving ? 0.022 : 0.008);
    this.body.rotation.z = moving ? Math.sin(time * 5.5) * 0.025 : 0;
    this.head.rotation.x = Math.sin(time * 1.8 + this.wobble) * (moving ? 0.045 : 0.025);
    this.head.rotation.y = Math.sin(time * 1.3 + this.wobble) * 0.055;
    for (const leg of this.legs) {
      const phase = time * 11 + leg.phase + this.wobble;
      const stride = moving ? Math.sin(phase) * 0.14 : gait * 0.025;
      const lift = moving ? Math.max(0, Math.cos(phase)) * 0.105 : 0;
      const hipZ = leg.row === 0 ? 0.16 : leg.row === 1 ? -0.01 : -0.18;
      const hip = new THREE.Vector3(leg.side * 0.12, 0.29, hipZ);
      const knee = new THREE.Vector3(leg.side * 0.34, 0.16 + lift * 0.45, hipZ + stride * 0.55 + (leg.row === 0 ? 0.07 : leg.row === 2 ? -0.05 : 0));
      const foot = new THREE.Vector3(leg.side * 0.47, 0.035 + lift, hipZ + stride + (leg.row === 0 ? 0.17 : leg.row === 2 ? -0.16 : 0));
      this.placeSegment(leg.upper, hip, knee);
      this.placeSegment(leg.lower, knee, foot);
    }
    for (const antenna of this.antennae) {
      const swing = Math.sin(time * 3.1 + antenna.phase) * 0.08;
      const start = new THREE.Vector3(antenna.side * 0.075, 0.12, 0.18);
      const end = new THREE.Vector3(antenna.side * (0.2 + swing), 0.42 + Math.sin(time * 2 + antenna.phase) * 0.035, 0.37);
      this.placeSegment(antenna.mesh, start, end);
    }
  }

  setVisible(visible: boolean): void { this.group.visible = visible; }

  dispose(): void {
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        if (object.geometry !== sphereGeometry && object.geometry !== legGeometry && object.geometry !== antennaGeometry) object.geometry.dispose();
      }
    });
    this.shell.dispose();
    this.thoraxMaterial.dispose();
    this.legMaterial.dispose();
  }

  private part(geometry: THREE.BufferGeometry, material: THREE.Material, position: { x: number; y: number; z: number }, scale: { x: number; y: number; z: number }, parent = this.body): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position.x, position.y, position.z);
    mesh.scale.set(scale.x, scale.y, scale.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private placeSegment(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3): void {
    const direction = to.clone().sub(from);
    const length = direction.length();
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    mesh.scale.set(1, Math.max(0.05, length), 1);
  }
}

export function roleOfAgent(agent: AgentState): AgentRole { return agent.role; }
export function roleOfPlayer(_player: PlayerState): AgentRole { return 'worker'; }
