import * as THREE from 'three';
import type { BuildKind, PheromoneType, ResourceKind, ResourceNode, StructureState, WeatherKind, WorldTime, StaticProp } from '../../../shared/src/types.js';
import { createWorldProps, isInPond, mulberry32, terrainHeight } from '../../../shared/src/world.js';

const PHR_COLOR: Record<PheromoneType, string> = {
  food: '#f2ba59', danger: '#fb715a', home: '#78e6bc', explore: '#a2dbff', defence: '#f297db',
};
const resourceColors: Record<ResourceKind, string> = {
  seed: '#bd9a61', berry: '#d65c6b', sugar: '#f0c671', dew: '#78c8df', soil: '#866043', leaf: '#77a867', mushroom: '#d89c78',
};

export class Environment {
  readonly surfaceGroup = new THREE.Group();
  readonly nestGroup = new THREE.Group();
  private readonly surfacePlants = new THREE.Group();
  private readonly resourceGroup = new THREE.Group();
  private readonly structureGroup = new THREE.Group();
  private readonly pheromoneGroup = new THREE.Group();
  private readonly scene: THREE.Scene;
  private readonly sun: THREE.DirectionalLight;
  private readonly skyLight: THREE.HemisphereLight;
  private readonly caveLight: THREE.PointLight;
  private readonly caveAmbient: THREE.AmbientLight;
  private readonly fireflies: THREE.Points;
  private readonly fireflyPositions: Float32Array;
  private readonly fireflyBase: Array<{ x: number; y: number; z: number; phase: number }> = [];
  private readonly rain: THREE.LineSegments;
  private readonly rainPositions: Float32Array;
  private readonly resourceVisuals = new Map<string, THREE.Group>();
  private readonly structureVisuals = new Map<string, THREE.Group>();
  private readonly pheroPoints = new Map<PheromoneType, THREE.Points>();
  private cameraObstacles: THREE.Object3D[] = [];
  private grassMeshes: THREE.InstancedMesh[] = [];
  private seed = 0;
  private currentWeather: WeatherKind = 'clear';
  private currentQuality: 'low' | 'medium' | 'high' = 'high';
  private isUnderground = false;
  private pond: THREE.Mesh | null = null;
  private pondRing: THREE.Mesh | null = null;
  private terrain: THREE.Mesh | null = null;
  private readonly rainMaterial: THREE.LineBasicMaterial;
  private readonly fireflyMaterial: THREE.PointsMaterial;

  constructor(scene: THREE.Scene, seed: number) {
    this.scene = scene;
    this.surfaceGroup.name = 'surface-world';
    this.nestGroup.name = 'formicarium';
    this.scene.add(this.surfaceGroup, this.nestGroup);
    this.surfaceGroup.add(this.surfacePlants, this.resourceGroup, this.pheromoneGroup);

    this.skyLight = new THREE.HemisphereLight('#ddedcc', '#473f2c', 1.7);
    this.scene.add(this.skyLight);
    this.sun = new THREE.DirectionalLight('#ffe5bc', 3.1);
    this.sun.position.set(-35, 55, 28);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1536, 1536);
    this.sun.shadow.camera.left = -70;
    this.sun.shadow.camera.right = 70;
    this.sun.shadow.camera.top = 70;
    this.sun.shadow.camera.bottom = -70;
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.035;
    this.scene.add(this.sun);
    this.caveLight = new THREE.PointLight('#ffd18a', 12, 31, 1.8);
    this.caveLight.position.set(0, -4.5, -0.5);
    this.caveAmbient = new THREE.AmbientLight('#a9a57a', 0.55);

    this.fireflyPositions = new Float32Array(90 * 3);
    const fireflyGeometry = new THREE.BufferGeometry();
    fireflyGeometry.setAttribute('position', new THREE.BufferAttribute(this.fireflyPositions, 3));
    this.fireflyMaterial = new THREE.PointsMaterial({ color: '#d7ff9c', size: 0.17, transparent: true, opacity: 0.6, depthWrite: false, sizeAttenuation: true });
    this.fireflies = new THREE.Points(fireflyGeometry, this.fireflyMaterial);
    this.surfaceGroup.add(this.fireflies);

    this.rainPositions = new Float32Array(180 * 3 * 2);
    const rainGeometry = new THREE.BufferGeometry();
    rainGeometry.setAttribute('position', new THREE.BufferAttribute(this.rainPositions, 3));
    this.rainMaterial = new THREE.LineBasicMaterial({ color: '#b5d4e4', transparent: true, opacity: 0.0, depthWrite: false });
    this.rain = new THREE.LineSegments(rainGeometry, this.rainMaterial);
    this.surfaceGroup.add(this.rain);

    this.build(seed);
  }

  setSeed(seed: number): void {
    if (seed === this.seed) return;
    this.build(seed);
  }

  setUnderground(underground: boolean): void {
    this.isUnderground = underground;
    this.surfaceGroup.visible = !underground;
    this.nestGroup.visible = underground;
    this.sun.visible = !underground;
    this.skyLight.visible = !underground;
  }

  setQuality(quality: 'low' | 'medium' | 'high'): void {
    this.currentQuality = quality;
    const ratios = { low: 0.38, medium: 0.72, high: 1 };
    for (const mesh of this.grassMeshes) mesh.count = Math.floor(mesh.userData.fullCount * ratios[quality]);
    this.sun.castShadow = quality !== 'low';
    this.sun.shadow.mapSize.setScalar(quality === 'high' ? 1536 : quality === 'medium' ? 1024 : 512);
  }

  resolveCameraPosition(target: THREE.Vector3, desired: THREE.Vector3): THREE.Vector3 {
    const direction = desired.clone().sub(target);
    const distance = direction.length();
    if (distance > 0.01) {
      direction.normalize();
      const raycaster = new THREE.Raycaster(target, direction, 0.38, distance);
      const hit = raycaster.intersectObjects(this.cameraObstacles, true)[0];
      if (hit) desired.copy(target).addScaledVector(direction, Math.max(0.42, hit.distance - 0.3));
    }
    const floor = terrainHeight(desired.x, desired.z) + 0.38;
    if (desired.y < floor) desired.y = floor;
    return desired;
  }

  syncResources(resources: ResourceNode[]): void {
    const live = new Set(resources.map((node) => node.id));
    for (const [id, visual] of this.resourceVisuals) {
      if (!live.has(id)) {
        visual.parent?.remove(visual);
        disposeObject(visual);
        this.resourceVisuals.delete(id);
      }
    }
    for (const node of resources) {
      let visual = this.resourceVisuals.get(node.id);
      if (!visual) {
        visual = makeResourceVisual(node.kind);
        visual.name = node.id;
        this.resourceGroup.add(visual);
        this.resourceVisuals.set(node.id, visual);
      }
      visual.position.set(node.pos.x, node.pos.y + (node.amount > 0 ? 0.1 : 0), node.pos.z);
      visual.visible = node.amount >= 1;
      visual.scale.setScalar(node.amount > 0 ? 1 : 0.001);
    }
  }

  syncStructures(structures: StructureState[]): void {
    const live = new Set(structures.map((structure) => structure.id));
    for (const [id, visual] of this.structureVisuals) {
      if (!live.has(id)) {
        visual.parent?.remove(visual);
        disposeObject(visual);
        this.structureVisuals.delete(id);
      }
    }
    for (const structure of structures) {
      let visual = this.structureVisuals.get(structure.id);
      if (!visual) {
        visual = makeStructureVisual(structure.kind);
        visual.name = structure.id;
        this.structureGroup.add(visual);
        this.structureVisuals.set(structure.id, visual);
      }
      visual.position.set(structure.pos.x, structure.pos.y, structure.pos.z);
      visual.rotation.y = structure.rotation;
    }
  }

  syncPheromones(cells: Array<{ x: number; z: number; type: PheromoneType; strength: number }>): void {
    const byType = new Map<PheromoneType, Array<{ x: number; z: number; y: number; strength: number }>>();
    for (const cell of cells) {
      if (cell.strength < 0.08) continue;
      const list = byType.get(cell.type) ?? [];
      const underground = Math.hypot(cell.x, cell.z) < 5;
      list.push({ x: cell.x, z: cell.z, y: underground ? -7.1 : terrainHeight(cell.x, cell.z) + 0.12, strength: cell.strength });
      byType.set(cell.type, list);
    }
    const types: PheromoneType[] = ['food', 'danger', 'home', 'explore', 'defence'];
    for (const type of types) {
      const items = byType.get(type) ?? [];
      let points = this.pheroPoints.get(type);
      if (!points) {
        const geometry = new THREE.BufferGeometry();
        const material = new THREE.PointsMaterial({ color: PHR_COLOR[type], size: 0.5, transparent: true, opacity: 0.46, depthWrite: false, sizeAttenuation: true });
        points = new THREE.Points(geometry, material);
        points.renderOrder = 4;
        this.pheromoneGroup.add(points);
        this.pheroPoints.set(type, points);
      }
      const positions = new Float32Array(items.length * 3);
      const colors = new Float32Array(items.length * 3);
      const base = new THREE.Color(PHR_COLOR[type]);
      for (let i = 0; i < items.length; i += 1) {
        positions[i * 3] = items[i].x;
        positions[i * 3 + 1] = items[i].y;
        positions[i * 3 + 2] = items[i].z;
        const intensity = 0.35 + items[i].strength * 0.65;
        colors[i * 3] = base.r * intensity;
        colors[i * 3 + 1] = base.g * intensity;
        colors[i * 3 + 2] = base.b * intensity;
      }
      points.geometry.dispose();
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      points.geometry = geometry;
      (points.material as THREE.PointsMaterial).vertexColors = true;
      points.visible = items.length > 0;
    }
  }

  update(time: number, worldTime: WorldTime): void {
    this.updateDaylight(time, worldTime);
    this.updateWeather(worldTime.weather);
    if (this.pondRing) this.pondRing.rotation.z = Math.sin(time * 0.23) * 0.04;
    if (this.pond) (this.pond.material as THREE.MeshPhysicalMaterial).roughness = 0.16 + Math.sin(time * 0.9) * 0.035;
    this.updateFireflies(time, worldTime);
    this.updateRain(time, worldTime.weather);
  }

  dispose(): void {
    disposeObject(this.surfaceGroup);
    disposeObject(this.nestGroup);
    this.scene.remove(this.surfaceGroup, this.nestGroup, this.sun, this.skyLight);
    this.sun.shadow.dispose();
  }

  private build(seed: number): void {
    this.seed = seed;
    clearGroup(this.surfacePlants);
    clearGroup(this.resourceGroup);
    clearGroup(this.structureGroup);
    clearGroup(this.pheromoneGroup);
    clearGroup(this.nestGroup);
    if (this.terrain) {
      this.surfaceGroup.remove(this.terrain);
      disposeObject(this.terrain);
    }
    this.resourceVisuals.clear();
    this.structureVisuals.clear();
    this.pheroPoints.clear();
    this.grassMeshes = [];
    this.pond = null;
    this.pondRing = null;

    this.nestGroup.add(this.caveLight, this.caveAmbient);
    const random = mulberry32(seed);
    this.terrain = createTerrain(seed);
    this.surfaceGroup.add(this.terrain);
    const props = createWorldProps(seed);
    this.buildVegetation(props, random);
    this.buildEntrance(random);
    this.buildPond(random);
    this.buildCave(random);
    this.buildFireflies(random);
    this.buildRain(random);
    this.setQuality(this.currentQuality);
    this.setUnderground(this.isUnderground);
  }

  private buildVegetation(props: StaticProp[], random: () => number): void {
    const surface = this.surfacePlants;
    const rockProps = props.filter((prop) => prop.kind === 'rock');
    const logs = props.filter((prop) => prop.kind === 'log');
    const stumps = props.filter((prop) => prop.kind === 'stump');
    const trees = props.filter((prop) => prop.kind === 'tree');
    const flowers = props.filter((prop) => prop.kind === 'flower');
    const mushrooms = props.filter((prop) => prop.kind === 'mushroom');
    const ferns = props.filter((prop) => prop.kind === 'fern');
    const leaves = props.filter((prop) => prop.kind === 'leaf');

    this.grassMeshes.push(makeGrass(surface, 2_650, random));
    const rockMeshes = makeRocks(rockProps, random);
    const logMeshes = makeLogs(logs, random);
    const stumpMeshes = makeStumps(stumps, random);
    const treeMeshes = makeTrees(trees, random);
    this.cameraObstacles = [this.terrain!, rockMeshes, logMeshes, stumpMeshes, treeMeshes];
    surface.add(rockMeshes, logMeshes, stumpMeshes, treeMeshes);
    surface.add(makeFlowers(flowers, random));
    surface.add(makeMushrooms(mushrooms, random));
    surface.add(makeFerns(ferns, random));
    surface.add(makeLeaves(leaves, random));
    surface.add(makeGroundCover(600, random));
  }

  private buildEntrance(random: () => number): void {
    const group = new THREE.Group();
    const ground = terrainHeight(0, 0);
    const holeMaterial = new THREE.MeshStandardMaterial({ color: '#281c17', roughness: 1, side: THREE.DoubleSide });
    const rimMaterial = new THREE.MeshStandardMaterial({ color: '#98714a', roughness: 0.92 });
    const hole = new THREE.Mesh(new THREE.CircleGeometry(2.0, 40), holeMaterial);
    hole.rotation.x = -Math.PI / 2;
    hole.position.set(0, ground + 0.04, 0);
    group.add(hole);
    const lip = new THREE.Mesh(new THREE.TorusGeometry(2.05, 0.21, 8, 48), rimMaterial);
    lip.rotation.x = Math.PI / 2;
    lip.position.set(0, ground + 0.1, 0);
    group.add(lip);
    for (let i = 0; i < 8; i += 1) {
      const root = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.085, 1.1 + random() * 0.9, 6), new THREE.MeshStandardMaterial({ color: i % 2 ? '#6a4a30' : '#82603a', roughness: 0.9 }));
      const angle = i * Math.PI / 4 + random() * 0.2;
      root.position.set(Math.cos(angle) * (2.4 + random() * 0.35), ground + 0.35, Math.sin(angle) * (2.4 + random() * 0.35));
      root.rotation.z = Math.cos(angle) * 0.42;
      root.rotation.x = Math.sin(angle) * 0.38;
      group.add(root);
    }
    const marker = new THREE.Mesh(new THREE.TorusGeometry(2.8, 0.035, 6, 56), new THREE.MeshBasicMaterial({ color: '#e6bc74', transparent: true, opacity: 0.34 }));
    marker.rotation.x = Math.PI / 2;
    marker.position.set(0, ground + 0.08, 0);
    marker.name = 'nest-entrance-marker';
    group.add(marker);
    this.surfacePlants.add(group);
  }

  private buildPond(random: () => number): void {
    const group = new THREE.Group();
    const x = 22;
    const z = -22;
    const y = terrainHeight(x, z) + 0.045;
    const waterMaterial = new THREE.MeshPhysicalMaterial({ color: '#79c3bd', roughness: 0.16, metalness: 0.03, transparent: true, opacity: 0.86, clearcoat: 1, clearcoatRoughness: 0.08 });
    const pond = new THREE.Mesh(new THREE.CircleGeometry(7.1, 64), waterMaterial);
    pond.rotation.x = -Math.PI / 2;
    pond.position.set(x, y, z);
    group.add(pond);
    this.pond = pond;
    const shoreline = new THREE.Mesh(new THREE.TorusGeometry(7.25, 0.25, 8, 64), new THREE.MeshStandardMaterial({ color: '#907d50', roughness: 0.95 }));
    shoreline.rotation.x = Math.PI / 2;
    shoreline.position.set(x, y - 0.06, z);
    group.add(shoreline);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.5, 0.045, 6, 64), new THREE.MeshBasicMaterial({ color: '#c0f5e3', transparent: true, opacity: 0.2 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, y + 0.05, z);
    group.add(ring);
    this.pondRing = ring;
    for (let i = 0; i < 18; i += 1) {
      const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(0.25 + random() * 0.38, 0), new THREE.MeshStandardMaterial({ color: ['#8d8975', '#aaa18a', '#6d7868'][i % 3], roughness: 0.95 }));
      const angle = random() * Math.PI * 2;
      const radius = 7.2 + random() * 0.8;
      stone.position.set(x + Math.cos(angle) * radius, terrainHeight(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius) + 0.17, z + Math.sin(angle) * radius);
      stone.scale.y = 0.55;
      group.add(stone);
    }
    this.surfacePlants.add(group);
  }

  private buildCave(random: () => number): void {
    const groundY = -7.55;
    const soil = new THREE.MeshStandardMaterial({ color: '#37271f', roughness: 1, side: THREE.DoubleSide });
    const wall = new THREE.MeshStandardMaterial({ color: '#544032', roughness: 0.98, side: THREE.DoubleSide });
    const roof = new THREE.MeshStandardMaterial({ color: '#463329', roughness: 1, side: THREE.DoubleSide });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(7.2, 56), soil);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = groundY;
    this.nestGroup.add(floor);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(6.8, 36, 22, 0, Math.PI * 2, 0, Math.PI / 2), roof);
    dome.position.y = groundY;
    this.nestGroup.add(dome);

    for (let i = 0; i < 22; i += 1) {
      const angle = i / 22 * Math.PI * 2;
      const size = 0.85 + random() * 0.8;
      const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(1, 1), i % 4 === 0 ? roof : wall);
      const radius = 5.75 + random() * 0.35;
      stone.position.set(Math.cos(angle) * radius, -5.1 + random() * 0.4, Math.sin(angle) * radius);
      stone.scale.set(size * 0.8, 1.6 + random() * 1.2, size * 0.7);
      stone.rotation.set(random() * 0.2, angle, random() * 0.18);
      stone.castShadow = true;
      this.nestGroup.add(stone);
    }

    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.3, 5.4, 24, 1, true), new THREE.MeshStandardMaterial({ color: '#302018', roughness: 1, side: THREE.DoubleSide }));
    shaft.position.set(0, -3.55, 0);
    this.nestGroup.add(shaft);
    const shaftLip = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.13, 7, 32), wall);
    shaftLip.rotation.x = Math.PI / 2;
    shaftLip.position.set(0, -6.2, 0);
    this.nestGroup.add(shaftLip);

    const rootMaterial = new THREE.MeshStandardMaterial({ color: '#805938', roughness: 0.8 });
    for (let i = 0; i < 12; i += 1) {
      const angle = random() * Math.PI * 2;
      const root = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.07, 3.5 + random() * 2.2, 6), rootMaterial);
      root.position.set(Math.cos(angle) * (3.4 + random() * 1.2), -3.6, Math.sin(angle) * (3.4 + random() * 1.2));
      root.rotation.z = Math.cos(angle) * 0.28;
      root.rotation.x = Math.sin(angle) * 0.32;
      this.nestGroup.add(root);
    }

    const moss = new THREE.MeshStandardMaterial({ color: '#769865', emissive: '#1c3622', emissiveIntensity: 0.42, roughness: 0.8 });
    for (let i = 0; i < 18; i += 1) {
      const angle = random() * Math.PI * 2;
      const patch = new THREE.Mesh(new THREE.SphereGeometry(0.25 + random() * 0.42, 10, 8), moss);
      patch.position.set(Math.cos(angle) * (3.9 + random() * 1.4), groundY + 0.14, Math.sin(angle) * (3.9 + random() * 1.4));
      patch.scale.y = 0.38;
      this.nestGroup.add(patch);
    }

    this.structureGroup.name = 'built-colony-structures';
    this.nestGroup.add(this.structureGroup);
  }

  private buildFireflies(random: () => number): void {
    this.fireflyBase.length = 0;
    for (let i = 0; i < 90; i += 1) {
      const angle = random() * Math.PI * 2;
      const radius = 8 + random() * 64;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      this.fireflyBase.push({ x, y: terrainHeight(x, z) + 0.5 + random() * 2.4, z, phase: random() * Math.PI * 2 });
    }
  }

  private buildRain(random: () => number): void {
    for (let i = 0; i < 180; i += 1) {
      const index = i * 6;
      const x = (random() - 0.5) * 100;
      const z = (random() - 0.5) * 100;
      const y = 7 + random() * 26;
      this.rainPositions[index] = x;
      this.rainPositions[index + 1] = y;
      this.rainPositions[index + 2] = z;
      this.rainPositions[index + 3] = x - 0.15;
      this.rainPositions[index + 4] = y - 0.65;
      this.rainPositions[index + 5] = z;
    }
    this.rain.geometry.setAttribute('position', new THREE.BufferAttribute(this.rainPositions, 3));
    this.rain.geometry.computeBoundingSphere();
  }

  private updateDaylight(time: number, worldTime: WorldTime): void {
    const phase = (worldTime.seconds % worldTime.dayLength) / worldTime.dayLength;
    const sunHeight = Math.sin((phase - 0.25) * Math.PI * 2);
    const day = THREE.MathUtils.smoothstep(sunHeight, -0.18, 0.34);
    const dusk = 1 - Math.min(1, Math.abs(phase - 0.25) / 0.14, Math.abs(phase - 0.75) / 0.14);
    const background = new THREE.Color('#101c25').lerp(new THREE.Color('#9fc3c0'), day).lerp(new THREE.Color('#e19568'), Math.max(0, dusk) * 0.32);
    if (this.currentWeather === 'mist') background.lerp(new THREE.Color('#879b96'), 0.32);
    if (this.currentWeather === 'rain') background.multiplyScalar(0.76);
    this.scene.background = background;
    this.scene.fog = new THREE.FogExp2(background, this.currentQuality === 'low' ? 0.014 : 0.009);
    this.sun.intensity = 0.34 + day * 2.65;
    this.sun.color.set(day < 0.3 ? '#bbd1e7' : '#ffe6c0');
    this.sun.position.set(Math.cos(phase * Math.PI * 2) * 42, 12 + Math.max(0, sunHeight) * 44, Math.sin(phase * Math.PI * 2) * 38);
    this.skyLight.intensity = 0.55 + day * 1.22;
    this.caveLight.intensity = this.isUnderground ? 11.5 + Math.sin(time * 1.9) * 0.28 : 0;
    this.fireflyMaterial.opacity = Math.max(0, 0.64 - day * 0.8);
    this.fireflyMaterial.size = this.currentQuality === 'low' ? 0.12 : 0.18;
  }

  private updateWeather(weather: WeatherKind): void {
    this.currentWeather = weather;
    const target = weather === 'rain' ? 0.58 : weather === 'drizzle' ? 0.26 : 0;
    this.rainMaterial.opacity = target;
    this.rain.visible = weather === 'rain' || weather === 'drizzle';
  }

  private updateFireflies(time: number, worldTime: WorldTime): void {
    const day = (worldTime.seconds % worldTime.dayLength) / worldTime.dayLength;
    const night = day < 0.19 || day > 0.79;
    this.fireflies.visible = night && !this.isUnderground;
    if (!this.fireflies.visible) return;
    for (let i = 0; i < this.fireflyBase.length; i += 1) {
      const point = this.fireflyBase[i];
      this.fireflyPositions[i * 3] = point.x + Math.sin(time * 0.4 + point.phase) * 0.22;
      this.fireflyPositions[i * 3 + 1] = point.y + Math.sin(time * 1.4 + point.phase) * 0.25;
      this.fireflyPositions[i * 3 + 2] = point.z + Math.cos(time * 0.34 + point.phase) * 0.22;
    }
    (this.fireflies.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  private updateRain(time: number, weather: WeatherKind): void {
    if (weather !== 'rain' && weather !== 'drizzle') return;
    const intensity = weather === 'rain' ? 1.25 : 0.7;
    for (let i = 0; i < this.rainPositions.length / 6; i += 1) {
      const index = i * 6;
      this.rainPositions[index + 1] -= 0.45 * intensity;
      this.rainPositions[index + 4] -= 0.45 * intensity;
      if (this.rainPositions[index + 1] < terrainHeight(this.rainPositions[index], this.rainPositions[index + 2]) + 0.4) {
        const x = this.rainPositions[index] = Math.sin(time * 0.21 + i * 7.3) * 51;
        const z = this.rainPositions[index + 2] = Math.cos(time * 0.13 + i * 3.9) * 51;
        const y = this.rainPositions[index + 1] = 16 + (i % 15);
        this.rainPositions[index + 3] = x - 0.15;
        this.rainPositions[index + 4] = y - 0.65;
        this.rainPositions[index + 5] = z;
      }
    }
    (this.rain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}

function createTerrain(seed: number): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(160, 160, 144, 144);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position as THREE.BufferAttribute;
  const colors: number[] = [];
  const color = new THREE.Color();
  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i);
    const z = positions.getZ(i);
    const height = terrainHeight(x, z);
    positions.setY(i, height);
    const shade = 0.84 + (Math.sin(x * 0.21 + seed * 0.01) * Math.cos(z * 0.17) + 1) * 0.08;
    const nestTint = Math.max(0, 1 - Math.hypot(x, z) / 16) * 0.12;
    color.setRGB(0.29 * shade + nestTint, 0.38 * shade - nestTint * 0.22, 0.18 * shade - nestTint * 0.2);
    colors.push(color.r, color.g, color.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  const texture = createSoilTexture(seed);
  const material = new THREE.MeshStandardMaterial({ map: texture, vertexColors: true, roughness: 1, metalness: 0 });
  const terrain = new THREE.Mesh(geometry, material);
  terrain.receiveShadow = true;
  terrain.name = 'procedural-ground';
  return terrain;
}

function createSoilTexture(seed: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#8b9a60';
  ctx.fillRect(0, 0, 512, 512);
  const random = mulberry32(seed ^ 0x2ab35);
  const colors = ['#415f3e', '#718254', '#9c955c', '#b4a674', '#66764b', '#544e35', '#d0b676'];
  for (let i = 0; i < 22_000; i += 1) {
    ctx.globalAlpha = 0.07 + random() * 0.22;
    ctx.fillStyle = colors[Math.floor(random() * colors.length)];
    const size = 1 + random() * 7;
    ctx.fillRect(random() * 512, random() * 512, size, size * (0.3 + random()));
  }
  ctx.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(7, 7);
  texture.anisotropy = 4;
  return texture;
}

function makeGrass(parent: THREE.Group, count: number, random: () => number): THREE.InstancedMesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.16, 0, 0, 0.16, 0, 0, 0.03, 0.58, 0.015,
    -0.1, 0, 0.005, 0.11, 0, 0.005, -0.04, 0.78, -0.01,
  ], 3));
  geometry.setIndex([0, 1, 2, 3, 4, 5]);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: '#6f994c', roughness: 0.88, side: THREE.DoubleSide, vertexColors: true });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.userData.fullCount = count;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  let visible = 0;
  while (visible < count) {
    const angle = random() * Math.PI * 2;
    const radius = Math.sqrt(random()) * 74;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    if (Math.hypot(x, z) < 5.2 || isInPond(x, z)) continue;
    const y = terrainHeight(x, z);
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, random() * Math.PI * 2, 0);
    const bladeScale = 0.7 + random() * 1.6;
    dummy.scale.set(0.72 + random() * 0.55, bladeScale, 0.72 + random() * 0.55);
    dummy.updateMatrix();
    mesh.setMatrixAt(visible, dummy.matrix);
    const hue = 0.24 + random() * 0.1;
    color.setHSL(hue, 0.24 + random() * 0.22, 0.25 + random() * 0.17);
    mesh.setColorAt(visible, color);
    visible += 1;
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  parent.add(mesh);
  return mesh;
}

function makeRocks(props: StaticProp[], random: () => number): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: '#8c8977', roughness: 0.94, vertexColors: true });
  const mesh = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 1), material, props.length);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  props.forEach((prop, index) => {
    dummy.position.set(prop.x, terrainHeight(prop.x, prop.z) + prop.height * 0.39, prop.z);
    dummy.rotation.set(random() * 0.25, random() * Math.PI, random() * 0.3);
    dummy.scale.set(prop.radius, prop.height * 0.46, prop.radius * (0.65 + random() * 0.3));
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
    color.setHSL(0.11 + random() * 0.07, 0.09 + random() * 0.08, 0.34 + random() * 0.2);
    mesh.setColorAt(index, color);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

function makeLogs(props: StaticProp[], random: () => number): THREE.Group {
  const group = new THREE.Group();
  const bark = new THREE.MeshStandardMaterial({ color: '#735033', roughness: 0.94, vertexColors: true });
  const geometry = new THREE.CylinderGeometry(0.29, 0.42, 1, 10, 1);
  const mesh = new THREE.InstancedMesh(geometry, bark, props.length);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  props.forEach((prop, index) => {
    const rotation = new THREE.Euler(0.1 + random() * 0.2, random() * Math.PI * 2, Math.PI / 2 + (random() - 0.5) * 0.18);
    dummy.position.set(prop.x, terrainHeight(prop.x, prop.z) + 0.42, prop.z);
    dummy.rotation.copy(rotation);
    dummy.scale.set(0.8 + random() * 0.4, prop.radius * 2.0, 0.8 + random() * 0.4);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
    color.setHSL(0.075 + random() * 0.04, 0.35, 0.24 + random() * 0.13);
    mesh.setColorAt(index, color);
  });
  mesh.castShadow = true;
  group.add(mesh);
  return group;
}

function makeStumps(props: StaticProp[], random: () => number): THREE.Group {
  const group = new THREE.Group();
  const geometry = new THREE.CylinderGeometry(0.38, 0.52, 1, 12, 2);
  const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ color: '#725338', roughness: 0.95, vertexColors: true }), props.length);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  props.forEach((prop, index) => {
    dummy.position.set(prop.x, terrainHeight(prop.x, prop.z) + prop.height * 0.24, prop.z);
    dummy.rotation.y = random() * Math.PI;
    dummy.scale.set(prop.radius, Math.min(prop.height, 2.1) * 0.42, prop.radius);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
    color.setHSL(0.08 + random() * 0.04, 0.34, 0.25 + random() * 0.1);
    mesh.setColorAt(index, color);
  });
  mesh.castShadow = true;
  group.add(mesh);
  return group;
}

function makeTrees(props: StaticProp[], random: () => number): THREE.Group {
  const group = new THREE.Group();
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.28, 0.55, 1, 9, 3), new THREE.MeshStandardMaterial({ color: '#725337', roughness: 0.95, vertexColors: true }), props.length);
  const canopy = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshStandardMaterial({ color: '#496e43', roughness: 0.88, vertexColors: true }), props.length * 3);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  props.forEach((prop, index) => {
    const ground = terrainHeight(prop.x, prop.z);
    dummy.position.set(prop.x, ground + prop.height * 0.34, prop.z);
    dummy.rotation.set(0, random() * Math.PI, (random() - 0.5) * 0.08);
    dummy.scale.set(prop.radius * 0.35, prop.height * 0.68, prop.radius * 0.35);
    dummy.updateMatrix();
    trunks.setMatrixAt(index, dummy.matrix);
    color.setHSL(0.08, 0.29, 0.22 + random() * 0.1);
    trunks.setColorAt(index, color);
    for (let cluster = 0; cluster < 3; cluster += 1) {
      const angle = cluster * Math.PI * 2 / 3 + random() * 0.7;
      const crownRadius = prop.radius * (1.4 + random() * 0.7);
      dummy.position.set(prop.x + Math.cos(angle) * crownRadius * 0.33, ground + prop.height * (0.65 + cluster * 0.045), prop.z + Math.sin(angle) * crownRadius * 0.33);
      dummy.rotation.set(random() * 0.2, angle, random() * 0.2);
      dummy.scale.set(crownRadius, prop.height * (0.25 + random() * 0.04), crownRadius * 0.87);
      dummy.updateMatrix();
      canopy.setMatrixAt(index * 3 + cluster, dummy.matrix);
      color.setHSL(0.23 + random() * 0.08, 0.26 + random() * 0.14, 0.23 + random() * 0.11);
      canopy.setColorAt(index * 3 + cluster, color);
    }
  });
  trunks.castShadow = canopy.castShadow = true;
  trunks.receiveShadow = canopy.receiveShadow = true;
  group.add(trunks, canopy);
  return group;
}

function makeFlowers(props: StaticProp[], random: () => number): THREE.Group {
  const group = new THREE.Group();
  const stem = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.018, 0.028, 1, 5), new THREE.MeshStandardMaterial({ color: '#62824b', vertexColors: true }), props.length);
  const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.11, 9, 7), new THREE.MeshStandardMaterial({ color: '#f3c57a', roughness: 0.5, vertexColors: true }), props.length);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  props.forEach((prop, index) => {
    const y = terrainHeight(prop.x, prop.z);
    const height = prop.height * (0.65 + random() * 0.3);
    dummy.position.set(prop.x, y + height / 2, prop.z);
    dummy.rotation.z = (random() - 0.5) * 0.12;
    dummy.scale.set(1, height, 1);
    dummy.updateMatrix();
    stem.setMatrixAt(index, dummy.matrix);
    color.setHSL(0.26 + random() * 0.07, 0.24, 0.33);
    stem.setColorAt(index, color);
    dummy.position.set(prop.x, y + height, prop.z);
    dummy.rotation.set(random() * 0.3, random() * Math.PI, random() * 0.2);
    dummy.scale.set(1, 0.8 + random() * 0.5, 1);
    dummy.updateMatrix();
    heads.setMatrixAt(index, dummy.matrix);
    const petals = ['#f1cb72', '#e98fa1', '#c0a8e7', '#fff1c3', '#df6c55'];
    color.set(petals[prop.variant % petals.length]);
    heads.setColorAt(index, color);
  });
  stem.castShadow = heads.castShadow = true;
  group.add(stem, heads);
  return group;
}

function makeMushrooms(props: StaticProp[], random: () => number): THREE.Group {
  const group = new THREE.Group();
  const stem = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.14, 1, 8), new THREE.MeshStandardMaterial({ color: '#e7d6bb', vertexColors: true }), props.length);
  const cap = new THREE.InstancedMesh(new THREE.SphereGeometry(0.33, 12, 8), new THREE.MeshStandardMaterial({ color: '#b96555', roughness: 0.72, vertexColors: true }), props.length);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  props.forEach((prop, index) => {
    const y = terrainHeight(prop.x, prop.z);
    const height = prop.height * 0.65;
    dummy.position.set(prop.x, y + height / 2, prop.z);
    dummy.scale.set(0.6, height, 0.6);
    dummy.updateMatrix();
    stem.setMatrixAt(index, dummy.matrix);
    color.setHSL(0.08, 0.18, 0.78 + random() * 0.1);
    stem.setColorAt(index, color);
    dummy.position.set(prop.x, y + height, prop.z);
    dummy.scale.set(0.78 + random() * 0.55, 0.46 + random() * 0.3, 0.78 + random() * 0.55);
    dummy.updateMatrix();
    cap.setMatrixAt(index, dummy.matrix);
    color.setHSL(prop.variant === 0 ? 0.025 : 0.07, 0.42 + random() * 0.14, 0.43 + random() * 0.15);
    cap.setColorAt(index, color);
  });
  stem.castShadow = cap.castShadow = true;
  group.add(stem, cap);
  return group;
}

function makeFerns(props: StaticProp[], random: () => number): THREE.Group {
  const group = new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-0.04, 0, 0, 0.04, 0, 0, 0.02, 1, 0.02], 3));
  geometry.setIndex([0, 1, 2]);
  geometry.computeVertexNormals();
  const instances = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ color: '#50884d', side: THREE.DoubleSide, vertexColors: true, roughness: 0.85 }), props.length * 7);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  props.forEach((prop, index) => {
    const y = terrainHeight(prop.x, prop.z);
    for (let leaf = 0; leaf < 7; leaf += 1) {
      const angle = leaf / 7 * Math.PI * 2 + random() * 0.3;
      const radius = 0.18 + random() * 0.22;
      dummy.position.set(prop.x + Math.cos(angle) * radius, y, prop.z + Math.sin(angle) * radius);
      dummy.rotation.set(0.32 + random() * 0.3, angle, -Math.cos(angle) * 0.28);
      dummy.scale.set(0.75 + random() * 0.6, prop.height * (0.5 + random() * 0.4), 1);
      dummy.updateMatrix();
      instances.setMatrixAt(index * 7 + leaf, dummy.matrix);
      color.setHSL(0.25 + random() * 0.09, 0.28, 0.3 + random() * 0.13);
      instances.setColorAt(index * 7 + leaf, color);
    }
  });
  instances.castShadow = true;
  group.add(instances);
  return group;
}

function makeLeaves(props: StaticProp[], random: () => number): THREE.Group {
  const group = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.quadraticCurveTo(0.52, 0.35, 0, 1.2);
  shape.quadraticCurveTo(-0.52, 0.35, 0, 0);
  const geometry = new THREE.ShapeGeometry(shape, 6);
  const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ color: '#688f4f', side: THREE.DoubleSide, roughness: 0.82, vertexColors: true }), props.length);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  props.forEach((prop, index) => {
    dummy.position.set(prop.x, terrainHeight(prop.x, prop.z) + 0.04, prop.z);
    dummy.rotation.set(-Math.PI / 2 + random() * 0.08, random() * Math.PI, random() * 0.08);
    dummy.scale.set(0.45 + random() * 0.65, 0.6 + random() * 0.75, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
    color.setHSL(0.22 + random() * 0.08, 0.28 + random() * 0.18, 0.32 + random() * 0.13);
    mesh.setColorAt(index, color);
  });
  group.add(mesh);
  return group;
}

function makeGroundCover(count: number, random: () => number): THREE.Group {
  const group = new THREE.Group();
  const geometry = new THREE.SphereGeometry(0.13, 7, 5);
  const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial({ color: '#b19a68', roughness: 1, vertexColors: true }), count);
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  let visible = 0;
  while (visible < count) {
    const x = (random() - 0.5) * 148;
    const z = (random() - 0.5) * 148;
    if (Math.hypot(x, z) < 6 || isInPond(x, z)) continue;
    dummy.position.set(x, terrainHeight(x, z) + 0.04, z);
    dummy.scale.set(0.2 + random() * 0.6, 0.08 + random() * 0.12, 0.14 + random() * 0.35);
    dummy.rotation.y = random() * Math.PI;
    dummy.updateMatrix();
    mesh.setMatrixAt(visible, dummy.matrix);
    color.setHSL(0.12 + random() * 0.08, 0.25 + random() * 0.2, 0.36 + random() * 0.22);
    mesh.setColorAt(visible, color);
    visible += 1;
  }
  mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

function makeResourceVisual(kind: ResourceKind): THREE.Group {
  const group = new THREE.Group();
  const color = resourceColors[kind];
  const material = new THREE.MeshPhysicalMaterial({ color, roughness: kind === 'dew' ? 0.12 : 0.58, metalness: kind === 'dew' ? 0.08 : 0.02, clearcoat: kind === 'dew' ? 1 : 0.3 });
  const glint = new THREE.MeshStandardMaterial({ color: '#f8e5b9', roughness: 0.3 });
  if (kind === 'seed') {
    const seed = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 9), material);
    seed.scale.set(0.72, 0.65, 1.2);
    group.add(seed);
    const seam = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), glint);
    seam.position.set(0.08, 0.09, 0.04);
    group.add(seam);
  } else if (kind === 'berry') {
    const berry = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), material);
    berry.scale.set(1, 0.87, 0.95);
    group.add(berry);
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.15, 5), new THREE.MeshStandardMaterial({ color: '#6c984f' }));
    leaf.position.y = 0.22;
    group.add(leaf);
  } else if (kind === 'sugar') {
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.2, 1), material);
    crystal.scale.set(1.2, 0.62, 0.9);
    group.add(crystal);
  } else if (kind === 'dew') {
    const drop = new THREE.Mesh(new THREE.SphereGeometry(0.19, 14, 10), material);
    drop.scale.set(0.72, 1.2, 0.72);
    group.add(drop);
  } else if (kind === 'leaf') {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 7), material);
    leaf.scale.set(0.22, 0.03, 0.6);
    leaf.rotation.y = 0.5;
    group.add(leaf);
  } else if (kind === 'mushroom') {
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.28, 8), glint);
    stem.position.y = 0.08;
    group.add(stem);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), material);
    cap.scale.y = 0.55;
    cap.position.y = 0.23;
    group.add(cap);
  } else {
    const clod = new THREE.Mesh(new THREE.DodecahedronGeometry(0.21, 1), material);
    clod.scale.set(1.2, 0.72, 0.9);
    group.add(clod);
  }
  group.traverse((object) => { if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; } });
  return group;
}

function makeStructureVisual(kind: BuildKind): THREE.Group {
  const group = new THREE.Group();
  const earth = new THREE.MeshStandardMaterial({ color: '#624632', roughness: 1, side: THREE.DoubleSide });
  const trim = new THREE.MeshStandardMaterial({ color: '#92714b', roughness: 0.92 });
  const moss = new THREE.MeshStandardMaterial({ color: '#63915b', emissive: '#142b19', emissiveIntensity: 0.28, roughness: 0.78 });
  if (kind === 'tunnel') {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.74, 0.74, 4.3, 18, 1, true), earth);
    tube.rotation.x = Math.PI / 2;
    tube.position.y = 0.08;
    group.add(tube);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.74, 0.09, 7, 24), trim);
    rim.rotation.y = Math.PI / 2;
    rim.position.z = 2.02;
    group.add(rim);
  } else if (kind === 'barrier') {
    for (let i = 0; i < 5; i += 1) {
      const twig = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.18, 1.8, 6), trim);
      twig.position.set((i - 2) * 0.45, 0.68 + (i % 2) * 0.18, 0);
      twig.rotation.z = (i - 2) * 0.1;
      group.add(twig);
    }
  } else {
    const radius = kind === 'chamber' ? 2.65 : kind === 'store' ? 2.35 : 2.2;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2), earth);
    dome.position.y = 0.04;
    group.add(dome);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.9, 28), trim);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.025;
    group.add(floor);
    if (kind === 'store') {
      for (let i = 0; i < 5; i += 1) {
        const grain = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 7), new THREE.MeshStandardMaterial({ color: '#d7ac61', roughness: 0.8 }));
        grain.position.set(Math.cos(i * 1.26) * 0.9, 0.25, Math.sin(i * 1.26) * 0.9);
        grain.scale.set(0.8, 0.68, 1);
        group.add(grain);
      }
    }
    if (kind === 'nursery') {
      for (let i = 0; i < 6; i += 1) {
        const egg = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 8), new THREE.MeshPhysicalMaterial({ color: '#f1dfb7', roughness: 0.28, clearcoat: 0.8 }));
        egg.position.set(Math.cos(i * 1.05) * 1.2, 0.16, Math.sin(i * 1.05) * 0.85);
        egg.scale.set(0.75, 1.15, 0.72);
        group.add(egg);
      }
      const patch = new THREE.Mesh(new THREE.CircleGeometry(0.75, 20), moss);
      patch.rotation.x = -Math.PI / 2;
      patch.position.y = 0.06;
      group.add(patch);
    }
  }
  group.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; });
  return group;
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.LineSegments)) return;
    object.geometry.dispose();
    const material = object.material;
    if (Array.isArray(material)) material.forEach((item) => item.dispose());
    else material.dispose();
  });
}

function clearGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    disposeObject(child);
  }
}
