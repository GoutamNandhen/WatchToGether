import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import cinemaScreenArtwork from "./cinema-screen.webp";

export type TheaterQuality = "low" | "medium" | "high";
export type TheaterSeat = "gallery" | "center" | "front";

type RendererReport = { fps: number | null; error: string | null };

const SCREEN_WIDTH = 14.4;
const SCREEN_HEIGHT = 8.1;
const SCREEN_Y = 5.05;
const SCREEN_Z = -12;

const SEATS: Record<TheaterSeat, THREE.Vector3> = {
  gallery: new THREE.Vector3(2.2, 3.95, 10.25),
  center: new THREE.Vector3(2.2, 2.9, 4.4),
  front: new THREE.Vector3(2.2, 1.95, -1.25),
};

/** Owns only the experimental scene. It never reads or writes room state. */
export class CinemaRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly mobile: boolean;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(47, 1, 0.05, 90);
  private readonly stereoCamera = new THREE.StereoCamera();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly unitBox = new THREE.BoxGeometry(1, 1, 1);
  private readonly roundedBox = new RoundedBoxGeometry(1, 1, 1, 2, 0.09);
  private readonly reclinerBack = this.createReclinerBack();
  private readonly placeholderCanvas = document.createElement("canvas");
  private readonly artworkImage = new Image();
  private artworkReady = false;
  private readonly placeholderTexture: THREE.CanvasTexture;
  private readonly screenMaterial: THREE.MeshBasicMaterial;
  private readonly screenMesh: THREE.Mesh;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly resizeObserver: ResizeObserver;
  private readonly onReport: (report: RendererReport) => void;
  private readonly onVisibility = () => {
    if (document.hidden && !this.renderer.xr.isPresenting) this.stop();
    else this.start();
  };
  private readonly onContextLost = (event: Event) => {
    event.preventDefault();
    this.fail("WebGL context lost. Reload this lab to restore the scene.");
    this.stop();
  };
  private running = false;
  private disposed = false;
  private frames = 0;
  private fpsWindow = 0;
  private lastPlaceholderDraw = 0;
  private drawCount = 0;
  private width = 1;
  private height = 1;
  private quality: TheaterQuality = "medium";
  private stereo = false;
  private videoTexture: THREE.VideoTexture | null = null;
  private manualYaw = 0;
  private manualPitch = 0;
  private sensorQuaternion: THREE.Quaternion | null = null;
  private sensorRecenter: THREE.Quaternion | null = null;
  private lastError: string | null = null;
  // Upgrades: smoothed look/seat, zoom, house lights, screen-reactive light, projector beam, WebXR.
  private readonly rig = new THREE.Group();
  private readonly rigTarget = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private fov = 47;
  private targetFov = 47;
  private playing = false;
  private houseLevel = 1;
  private readonly dimmables: Array<{ material: THREE.MeshBasicMaterial; base: THREE.Color }> = [];
  private readonly fillLights: Array<{ light: THREE.Light; base: number }> = [];
  private screenLight!: THREE.SpotLight;
  private spillLight!: THREE.PointLight;
  private readonly spillColor = new THREE.Color("#d9b48a");
  private readonly spillTarget = new THREE.Color("#d9b48a");
  private spillEnergy = 0.5;
  private spillEnergyTarget = 0.5;
  private readonly sampleCanvas = document.createElement("canvas");
  private lastSample = 0;
  private beamMaterial!: THREE.ShaderMaterial;
  private dust!: THREE.Points;
  private dustMaterial!: THREE.PointsMaterial;
  private lastTime = 0;
  private xrSession: XRSession | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    mobile: boolean,
    onReport: (report: RendererReport) => void,
  ) {
    this.canvas = canvas;
    this.mobile = mobile;
    this.onReport = onReport;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !mobile,
      powerPreference: "low-power",
      stencil: false,
      alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.5;
    this.scene.background = new THREE.Color("#110f12");
    this.scene.fog = new THREE.FogExp2("#110f12", 0.006);
    this.rig.add(this.camera);
    this.scene.add(this.rig);
    this.rig.position.copy(SEATS.center);
    this.rigTarget.copy(SEATS.center);
    this.faceScreen();
    this.yaw = this.manualYaw;
    this.pitch = this.manualPitch;
    this.sampleCanvas.width = 16;
    this.sampleCanvas.height = 9;
    this.renderer.xr.setReferenceSpaceType("local");
    this.stereoCamera.aspect = 0.5;
    this.stereoCamera.eyeSep = 0.065;

    this.placeholderCanvas.width = 1024;
    this.placeholderCanvas.height = 576;
    this.artworkImage.onload = () => {
      if (this.disposed) return;
      this.artworkReady = true;
      this.paintPlaceholder(performance.now());
    };
    this.placeholderTexture = new THREE.CanvasTexture(this.placeholderCanvas);
    this.placeholderTexture.colorSpace = THREE.SRGBColorSpace;
    this.placeholderTexture.minFilter = THREE.LinearFilter;
    this.screenMaterial = new THREE.MeshBasicMaterial({ map: this.placeholderTexture, color: "#ffffff", toneMapped: false, fog: false });
    this.materials.push(this.screenMaterial);
    // Gently curved screen: edges sweep ~45 cm toward the audience.
    const screenGeometry = new THREE.PlaneGeometry(1, 1, 48, 1);
    const sp = screenGeometry.attributes.position;
    for (let i = 0; i < sp.count; i++) sp.setZ(i, 1.8 * sp.getX(i) * sp.getX(i));
    sp.needsUpdate = true;
    screenGeometry.computeVertexNormals();
    this.geometries.push(screenGeometry);
    this.screenMesh = new THREE.Mesh(screenGeometry, this.screenMaterial);
    this.screenMesh.position.set(0, SCREEN_Y, SCREEN_Z + 0.12);
    this.screenMesh.scale.set(SCREEN_WIDTH, SCREEN_HEIGHT, 1);
    this.scene.add(this.screenMesh);
    this.artworkImage.src = cinemaScreenArtwork;
    this.buildCinema();
    this.buildAtmosphere();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.resize();
    this.start();
  }

  private material(color: string, metalness = 0, roughness = 0.9) {
    const material = new THREE.MeshStandardMaterial({ color, metalness, roughness });
    this.materials.push(material);
    return material;
  }

  private glow(color: string, dimmable = true) {
    const material = new THREE.MeshBasicMaterial({ color, toneMapped: false, fog: false });
    this.materials.push(material);
    if (dimmable) this.dimmables.push({ material, base: material.color.clone() });
    return material;
  }

  private createReclinerBack() {
    const profile = new THREE.Shape();
    profile.moveTo(-0.42, -0.5);
    profile.quadraticCurveTo(-0.53, -0.49, -0.54, -0.36);
    profile.lineTo(-0.51, 0.27);
    profile.quadraticCurveTo(-0.5, 0.48, -0.31, 0.5);
    profile.quadraticCurveTo(0, 0.54, 0.31, 0.5);
    profile.quadraticCurveTo(0.5, 0.48, 0.51, 0.27);
    profile.lineTo(0.54, -0.36);
    profile.quadraticCurveTo(0.53, -0.49, 0.42, -0.5);
    profile.closePath();
    const geometry = new THREE.ExtrudeGeometry(profile, { depth: 0.22, steps: 1, bevelEnabled: true, bevelThickness: 0.055, bevelSize: 0.045, bevelSegments: 2, curveSegments: 4 });
    geometry.translate(0, 0, -0.11);
    geometry.computeVertexNormals();
    return geometry;
  }

  private addBox(x: number, y: number, z: number, w: number, h: number, d: number, material: THREE.Material) {
    const mesh = new THREE.Mesh(this.unitBox, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, d);
    this.scene.add(mesh);
    return mesh;
  }

  private addInstances(material: THREE.Material, boxes: Array<[number, number, number, number, number, number]>, geometry: THREE.BufferGeometry = this.unitBox, tilt = 0) {
    const mesh = new THREE.InstancedMesh(geometry, material, boxes.length);
    const instance = new THREE.Object3D();
    boxes.forEach(([x, y, z, w, h, d], index) => {
      instance.position.set(x, y, z);
      instance.scale.set(w, h, d);
      instance.rotation.x = tilt;
      instance.updateMatrix();
      mesh.setMatrixAt(index, instance.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
  }

  private buildCinema() {
    const floor = this.material("#30292b", 0.08, 0.86);
    const riser = this.material("#211a1e", 0.05, 0.92);
    const wall = this.material("#292428", 0.04, 0.93);
    const acoustic = this.material("#40383b", 0.02, 0.96);
    const acousticInset = this.material("#211c22", 0.02, 1);
    const fabricSlat = this.material("#514148", 0.02, 1);
    const ceiling = this.material("#201d21", 0.05, 0.88);
    const velvet = this.material("#562934", 0.01, 1);
    const velvetAlternate = this.material("#67333c", 0.01, 1);
    const seatCushion = this.material("#77414b", 0.01, 0.98);
    const upholsterySeam = this.material("#a06668", 0, 1);
    const seatFrame = this.material("#242026", 0.18, 0.72);
    const bronze = this.material("#92734e", 0.58, 0.4);
    const darkBronze = this.material("#604b38", 0.45, 0.5);
    const goldLight = this.glow("#d7aa6d");
    const lowLight = this.glow("#8e633d");
    const sconceHalo = this.glow("#61402e");
    const screenBack = this.glow("#030405", false);

    // A compact 30 m auditorium with gentle seating tiers and a screen above a low stage.
    this.addBox(0, -0.19, 1.4, 22, 0.38, 30, floor);
    this.addBox(0, 9.64, 1.4, 22, 0.28, 30, ceiling);
    this.addBox(-10.95, 4.7, 1.4, 0.28, 9.6, 30, wall);
    this.addBox(10.95, 4.7, 1.4, 0.28, 9.6, 30, wall);
    this.addBox(0, 4.7, -13.45, 22, 9.6, 0.25, wall);
    this.addBox(0, 4.7, 16.25, 22, 9.6, 0.25, wall);

    // The video plane is the frontmost surface. All luminous trim sits outside its bounds.
    this.addBox(0, SCREEN_Y, SCREEN_Z - 0.08, 15.2, 8.72, 0.2, darkBronze);
    this.addBox(0, SCREEN_Y, SCREEN_Z + 0.005, SCREEN_WIDTH, SCREEN_HEIGHT, 0.08, screenBack);
    this.addBox(0, 9.27, SCREEN_Z + 0.16, 15.15, 0.08, 0.1, bronze);
    this.addBox(0, 0.83, SCREEN_Z + 0.16, 15.15, 0.08, 0.1, bronze);
    this.addBox(-7.56, SCREEN_Y, SCREEN_Z + 0.16, 0.08, 8.8, 0.1, bronze);
    this.addBox(7.56, SCREEN_Y, SCREEN_Z + 0.16, 0.08, 8.8, 0.1, bronze);
    this.addBox(0, 9.32, SCREEN_Z + 0.22, 14.9, 0.025, 0.025, lowLight);
    this.addBox(0, 0.22, -11.48, 17.5, 0.42, 3.5, riser);
    this.addBox(0, 0.46, -9.8, 18, 0.05, 0.06, bronze);
    this.addBox(-8.7, 4.75, -12.82, 1.2, 8.7, 0.16, acousticInset);
    this.addBox(8.7, 4.75, -12.82, 1.2, 8.7, 0.16, acousticInset);

    const panels: Array<[number, number, number, number, number, number]> = [];
    const insetPanels: typeof panels = [];
    const slats: typeof panels = [];
    const verticalTrim: typeof panels = [];
    const sconces: typeof panels = [];
    const halos: typeof panels = [];
    const ceilingRibs: typeof panels = [];
    const ceilingGlow: typeof panels = [];
    const aisleLamps: typeof panels = [];
    const stepEdges: typeof panels = [];

    for (let bay = 0; bay < 6; bay++) {
      const z = -9.5 + bay * 4.45;
      for (const side of [-1, 1]) {
        panels.push([side * 10.77, 4.7, z, 0.14, 7.75, 3.7]);
        insetPanels.push([side * 10.67, 4.76, z, 0.08, 6.9, 3.22]);
        for (let slat = 0; slat < 5; slat++) {
          slats.push([side * 10.59, 4.75, z - 1.25 + slat * 0.62, 0.045, 5.7, 0.065]);
        }
        verticalTrim.push([side * 10.59, 4.7, z - 1.77, 0.12, 8.1, 0.075]);
        verticalTrim.push([side * 10.58, 1.18, z, 0.1, 0.055, 3.34]);
        halos.push([side * 10.5, 4.65, z + 0.4, 0.025, 1.66, 0.92]);
        sconces.push([side * 10.45, 4.65, z + 0.4, 0.06, 0.65, 0.16]);
      }
      ceilingRibs.push([0, 9.43, z - 1.98, 21, 0.18, 0.18]);
      ceilingGlow.push([0, 9.33, z - 1.98, 13.6, 0.025, 0.03]);
    }
    this.addInstances(acoustic, panels);
    this.addInstances(acousticInset, insetPanels);
    this.addInstances(fabricSlat, slats);
    this.addInstances(bronze, verticalTrim);
    this.addInstances(sconceHalo, halos);
    this.addInstances(goldLight, sconces);
    this.addInstances(darkBronze, ceilingRibs);
    this.addInstances(lowLight, ceilingGlow);
    this.addBox(-9.3, 9.3, 1.4, 0.08, 0.08, 29, darkBronze);
    this.addBox(9.3, 9.3, 1.4, 0.08, 0.08, 29, darkBronze);
    this.addBox(0, 9.28, 1.4, 7.9, 0.06, 28.4, acousticInset);
    for (const side of [-1, 1]) {
      this.addBox(side * 10.42, 0.72, 1.4, 0.12, 0.16, 28, darkBronze);
      this.addBox(side * 10.38, 0.85, 1.4, 0.04, 0.025, 28, lowLight);
      this.addBox(side * 9.85, 9.34, 1.4, 0.06, 0.045, 28, goldLight);
      this.addBox(side * 8.35, 4.9, -12.71, 0.18, 8.1, 0.15, bronze);
      this.addBox(side * 8.33, 4.9, -12.6, 0.025, 7.8, 0.04, lowLight);
    }
    for (let bay = 0; bay < 6; bay++) {
      const z = -9.5 + bay * 4.45;
      this.addBox(0, 9.36, z, 16.8, 0.06, 3.15, ceiling);
      this.addBox(0, 9.30, z + 1.56, 17, 0.035, 0.045, lowLight);
    }

    const rowZ = [-1, 1.9, 4.8, 7.7, 10.6, 13.5];
    const seatX = [-8.6, -7, -5.4, -3.8, -2.2, 2.2, 3.8, 5.4, 7, 8.6];
    const seats: Array<[number, number, number]> = [];
    rowZ.forEach((z, row) => {
      const rise = row * 0.5;
      this.addBox(0, rise / 2 - 0.015, z, 21.3, rise + 0.07, 2.82, riser);
      stepEdges.push([0, rise + 0.03, z - 1.39, 21.2, 0.035, 0.045]);
      for (const x of seatX) seats.push([x, z, rise]);
      for (const side of [-1, 1]) {
        aisleLamps.push([side * 1.13, rise + 0.045, z - 1.17, 0.18, 0.04, 0.55]);
        aisleLamps.push([side * 9.97, rise + 0.045, z - 1.17, 0.18, 0.04, 0.55]);
      }
    });
    this.addInstances(darkBronze, stepEdges);
    this.addInstances(goldLight, aisleLamps);
    this.addBox(0, 0.015, 1.4, 2.14, 0.03, 28.5, floor);

    // Recliners share one bevelled silhouette and a handful of instanced upholstered parts.
    const frameParts: Array<[number, number, number, number, number, number]> = [];
    const backs: typeof frameParts = [];
    const alternateBacks: typeof frameParts = [];
    const headrests: typeof frameParts = [];
    const cushions: typeof frameParts = [];
    const sideBolsters: typeof frameParts = [];
    const armrests: typeof frameParts = [];
    const piping: typeof frameParts = [];
    const seams: typeof frameParts = [];
    seats.forEach(([x, z, rise], index) => {
      frameParts.push([x, rise + 0.38, z - 0.03, 1.42, 0.68, 1.32]);
      (Math.floor(index / seatX.length) % 2 === 0 ? backs : alternateBacks).push([x, rise + 1.25, z + 0.43, 1.17, 1.28, 1]);
      headrests.push([x, rise + 1.83, z + 0.50, 0.97, 0.26, 0.34]);
      cushions.push([x, rise + 0.76, z - 0.22, 1.24, 0.25, 1.05]);
      seams.push([x, rise + 0.77, z - 0.74, 0.78, 0.015, 0.018]);
      for (const side of [-1, 1]) {
        sideBolsters.push([x + side * 0.62, rise + 1.2, z + 0.36, 0.18, 1.17, 0.38]);
        armrests.push([x + side * 0.78, rise + 0.85, z - 0.13, 0.24, 0.33, 1.32]);
        piping.push([x + side * 0.78, rise + 1.02, z - 0.13, 0.17, 0.025, 1.19]);
      }
    });
    this.addInstances(seatFrame, frameParts, this.roundedBox);
    this.addInstances(velvet, backs, this.reclinerBack, 0.12);
    this.addInstances(velvetAlternate, alternateBacks, this.reclinerBack, 0.12);
    this.addInstances(seatCushion, headrests, this.roundedBox);
    this.addInstances(seatCushion, cushions, this.roundedBox);
    this.addInstances(velvet, sideBolsters, this.roundedBox);
    this.addInstances(seatFrame, armrests, this.roundedBox);
    this.addInstances(bronze, piping);
    this.addInstances(upholsterySeam, seams);

    // Static fills reveal upholstery and architecture; no shadow maps or post-processing.
    const ambient = new THREE.AmbientLight("#cbb8b2", 1.1);
    const hemi = new THREE.HemisphereLight("#f4dcc0", "#4c303a", 2.2);
    const frontFill = new THREE.DirectionalLight("#d6dee9", 1.25);
    frontFill.position.set(0, 8, -8);
    const aisleFill = new THREE.PointLight("#e2ae79", 55, 19, 2);
    aisleFill.position.set(0, 4.6, 5.5);
    for (const light of [ambient, hemi, frontFill, aisleFill]) {
      this.scene.add(light);
      // House lights never go fully black, so the room stays readable during the film.
      this.fillLights.push({ light, base: light.intensity });
    }
  }

  /** Curtains, screen-reactive lighting, projector booth, beam and floating dust. */
  private buildAtmosphere() {
    // Velvet stage curtains with soft folds, framing the screen.
    const curtainMaterial = new THREE.MeshStandardMaterial({ color: "#5a1e2a", roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
    this.materials.push(curtainMaterial);
    const curtainGeometry = new THREE.PlaneGeometry(2.9, 9.1, 64, 1);
    const cp = curtainGeometry.attributes.position;
    for (let i = 0; i < cp.count; i++) {
      const x = cp.getX(i);
      cp.setZ(i, Math.sin(x * 7.5) * 0.14 + Math.sin(x * 17) * 0.04);
    }
    cp.needsUpdate = true;
    curtainGeometry.computeVertexNormals();
    this.geometries.push(curtainGeometry);
    for (const side of [-1, 1]) {
      const curtain = new THREE.Mesh(curtainGeometry, curtainMaterial);
      curtain.position.set(side * 9.25, 4.85, -12.25);
      this.scene.add(curtain);
    }
    const valanceGeometry = new THREE.PlaneGeometry(21.4, 0.9, 120, 1);
    const vp = valanceGeometry.attributes.position;
    for (let i = 0; i < vp.count; i++) vp.setZ(i, Math.sin(vp.getX(i) * 4.2) * 0.1);
    vp.needsUpdate = true;
    valanceGeometry.computeVertexNormals();
    this.geometries.push(valanceGeometry);
    const valance = new THREE.Mesh(valanceGeometry, curtainMaterial);
    valance.position.set(0, 9.25, -12.1);
    this.scene.add(valance);

    // Light that takes its colour from the picture, washing the room like a real screen.
    // A wide, soft spot from the screen toward the seats (cheaper than an area light, no LUT download).
    this.screenLight = new THREE.SpotLight(this.spillColor, 0, 40, Math.PI / 2.6, 1, 1.2);
    this.screenLight.position.set(0, SCREEN_Y, SCREEN_Z + 0.6);
    this.screenLight.target.position.set(0, 1.5, 8);
    this.scene.add(this.screenLight, this.screenLight.target);
    this.spillLight = new THREE.PointLight(this.spillColor, 0, 30, 1.6);
    this.spillLight.position.set(0, SCREEN_Y - 1, SCREEN_Z + 5);
    this.scene.add(this.spillLight);

    // Projection booth window on the back wall.
    const booth = new THREE.Mesh(this.unitBox, this.glow("#fff1d6", false));
    booth.position.set(0, 8.4, 16.1);
    booth.scale.set(0.9, 0.5, 0.05);
    this.scene.add(booth);

    // Projector beam: an additive cone that fades toward the screen.
    const apex = new THREE.Vector3(0, 8.4, 16.0);
    const target = new THREE.Vector3(0, SCREEN_Y, SCREEN_Z);
    const length = apex.distanceTo(target);
    const beamGeometry = new THREE.ConeGeometry(8.2, length, 48, 1, true);
    beamGeometry.translate(0, -length / 2, 0);
    beamGeometry.rotateX(-Math.PI / 2);
    beamGeometry.scale(1, SCREEN_HEIGHT / SCREEN_WIDTH, 1);
    this.geometries.push(beamGeometry);
    this.beamMaterial = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 }, uColor: { value: this.spillColor } },
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: "uniform float uOpacity; uniform vec3 uColor; varying vec2 vUv; void main(){ float a = mix(0.15, 1.0, pow(vUv.y, 2.0)) * uOpacity; gl_FragColor = vec4(uColor * a, a); }",
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.materials.push(this.beamMaterial);
    const beam = new THREE.Mesh(beamGeometry, this.beamMaterial);
    beam.position.copy(apex);
    beam.lookAt(target);
    this.scene.add(beam);

    // Dust drifting through the beam.
    const count = this.mobile ? 220 : 520;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const t = Math.random();
      const p = apex.clone().lerp(target, t);
      const spread = 8.2 * t;
      positions[i * 3] = p.x + (Math.random() - 0.5) * spread * 1.6;
      positions[i * 3 + 1] = p.y + (Math.random() - 0.5) * spread * 0.9;
      positions[i * 3 + 2] = p.z;
    }
    const dustGeometry = new THREE.BufferGeometry();
    dustGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.geometries.push(dustGeometry);
    this.dustMaterial = new THREE.PointsMaterial({ color: "#fff3dc", size: 0.035, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    this.materials.push(this.dustMaterial);
    this.dust = new THREE.Points(dustGeometry, this.dustMaterial);
    this.scene.add(this.dust);
  }

  /** Average colour of what is on screen, sampled at 16×9, drives the room lighting. */
  private sampleScreen(time: number) {
    if (time - this.lastSample < 140) return;
    this.lastSample = time;
    const ctx = this.sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const source: CanvasImageSource | null = this.videoTexture ? (this.videoTexture.image as HTMLVideoElement) : this.placeholderCanvas;
    try {
      ctx.drawImage(source as CanvasImageSource, 0, 0, 16, 9);
      const data = ctx.getImageData(0, 0, 16, 9).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
      const n = data.length / 4;
      r /= n * 255; g /= n * 255; b /= n * 255;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      // Normalise hue so dark scenes still tint, and scale energy with brightness.
      const peak = Math.max(r, g, b, 0.001);
      this.spillTarget.setRGB(r / peak, g / peak, b / peak, THREE.SRGBColorSpace);
      this.spillEnergyTarget = 0.15 + luma * 1.6;
    } catch {
      /* Cross-origin or not-ready frames are skipped. */
    }
  }

  setPlaying(playing: boolean) {
    this.playing = playing;
  }

  zoom(delta: number) {
    this.targetFov = THREE.MathUtils.clamp(this.targetFov + delta, 28, 72);
  }

  static async isXRSupported() {
    try {
      return Boolean(navigator.xr && (await navigator.xr.isSessionSupported("immersive-vr")));
    } catch {
      return false;
    }
  }

  /** Enter a real headset session (Quest, Vision Pro, PC VR). Resolves when the session ends. */
  async enterXR(onEnd: () => void) {
    if (!navigator.xr) throw new Error("WebXR is not available in this browser.");
    const session = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor", "bounded-floor"] });
    this.renderer.xr.enabled = true;
    await this.renderer.xr.setSession(session);
    this.xrSession = session;
    // Face the screen from the chosen seat; the headset supplies head rotation.
    this.rig.rotation.set(0, this.manualYaw, 0);
    this.camera.quaternion.identity();
    session.addEventListener("end", () => {
      this.xrSession = null;
      this.renderer.xr.enabled = false;
      this.rig.rotation.set(0, 0, 0);
      this.camera.position.set(0, 0, 0);
      this.resize(true);
      onEnd();
    });
  }

  exitXR() {
    void this.xrSession?.end();
  }

  private paintPlaceholder(time: number) {
    const ctx = this.placeholderCanvas.getContext("2d");
    if (!ctx) return;
    const w = this.placeholderCanvas.width;
    const h = this.placeholderCanvas.height;
    if (this.artworkReady) {
      ctx.drawImage(this.artworkImage, 0, 0, w, h);
      const glow = ctx.createRadialGradient(w * 0.34, h * 0.38, 0, w * 0.34, h * 0.38, w * 0.48);
      glow.addColorStop(0, `rgba(255, 197, 112, ${0.035 + 0.018 * Math.sin(time * 0.00065)})`);
      glow.addColorStop(1, "rgba(255, 197, 112, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
      this.placeholderTexture.needsUpdate = true;
      return;
    }
    const sweep = (time * 0.000035) % 1;
    const background = ctx.createLinearGradient(0, 0, w, h);
    background.addColorStop(0, "#06090c");
    background.addColorStop(0.55, "#141318");
    background.addColorStop(1, "#050608");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
    const halo = ctx.createRadialGradient(w * (0.32 + sweep * 0.35), h * 0.48, 0, w * 0.5, h * 0.48, w * 0.65);
    halo.addColorStop(0, "rgba(136,93,51,0.22)");
    halo.addColorStop(1, "rgba(136,93,51,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(199,156,93,0.4)";
    ctx.lineWidth = 2;
    ctx.strokeRect(45, 44, w - 90, h - 88);
    ctx.strokeStyle = "rgba(199,156,93,0.16)";
    ctx.strokeRect(58, 57, w - 116, h - 114);
    ctx.save();
    ctx.translate(w / 2, h / 2 - 28);
    ctx.rotate(time * 0.00013);
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      ctx.fillStyle = `rgba(216,174,109,${0.12 + (i % 3) * 0.06})`;
      ctx.fillRect(Math.cos(angle) * 74 - 1, Math.sin(angle) * 74 - 1, 3, 3);
    }
    ctx.restore();
    ctx.textAlign = "center";
    ctx.fillStyle = "#d9bb86";
    ctx.font = "600 15px Georgia, serif";
    ctx.fillText("WATCHTOGETHER  ·  PRIVATE SCREENING", w / 2, h / 2 - 91);
    ctx.fillStyle = "#f4efe5";
    ctx.font = "54px Georgia, serif";
    ctx.fillText("THE CINEMA IS YOURS", w / 2, h / 2 + 52);
    ctx.fillStyle = "#a89b87";
    ctx.font = "18px Arial, sans-serif";
    ctx.fillText("Choose a local film to begin", w / 2, h / 2 + 97);
    this.placeholderTexture.needsUpdate = true;
  }

  private resize(force = false) {
    if (this.renderer.xr.isPresenting) return;
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    if (!force && width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  setQuality(quality: TheaterQuality) {
    this.quality = quality;
    const cap = quality === "low" ? 1 : quality === "medium" ? 1.35 : this.mobile ? 1.7 : 2;
    if (this.renderer.xr.isPresenting) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    this.renderer.setSize(this.width, this.height, false);
  }

  setSeat(seat: TheaterSeat) {
    // Glide to the new seat instead of teleporting.
    this.rigTarget.copy(SEATS[seat]);
    this.recenter();
  }

  private faceScreen() {
    const position = this.rigTarget;
    const depth = position.z - SCREEN_Z;
    this.manualYaw = Math.atan2(position.x, depth);
    this.manualPitch = Math.atan2(SCREEN_Y - position.y, Math.hypot(position.x, depth));
  }

  look(dx: number, dy: number) {
    if (this.sensorQuaternion) return;
    this.manualYaw -= dx * 0.003;
    this.manualPitch = THREE.MathUtils.clamp(this.manualPitch - dy * 0.003, -0.72, 0.72);
    this.manualYaw = THREE.MathUtils.clamp(this.manualYaw, -1.6, 1.6);
  }

  useMotion(alpha: number, beta: number, gamma: number, screenAngle: number) {
    const euler = new THREE.Euler(THREE.MathUtils.degToRad(beta), THREE.MathUtils.degToRad(alpha), -THREE.MathUtils.degToRad(gamma), "YXZ");
    const q = new THREE.Quaternion().setFromEuler(euler);
    q.multiply(new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2));
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -THREE.MathUtils.degToRad(screenAngle)));
    this.sensorQuaternion = q;
    if (!this.sensorRecenter) this.recenter();
  }

  disableMotion() {
    this.sensorQuaternion = null;
    this.sensorRecenter = null;
  }

  recenter() {
    this.faceScreen();
    if (this.sensorQuaternion) {
      const centeredView = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.manualPitch, this.manualYaw, 0, "YXZ"));
      this.sensorRecenter = centeredView.multiply(this.sensorQuaternion.clone().invert());
    }
  }

  setStereo(enabled: boolean, eyeSeparation = this.stereoCamera.eyeSep) {
    this.stereo = enabled;
    this.stereoCamera.eyeSep = eyeSeparation;
  }

  setEyeSeparation(value: number) {
    this.stereoCamera.eyeSep = value;
  }

  setVideo(video: HTMLVideoElement | null) {
    this.videoTexture?.dispose();
    this.videoTexture = null;
    this.screenMaterial.map = this.placeholderTexture;
    this.screenMesh.scale.set(SCREEN_WIDTH, SCREEN_HEIGHT, 1);
    if (video && video.videoWidth > 0 && video.videoHeight > 0) {
      const texture = new THREE.VideoTexture(video);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      this.videoTexture = texture;
      this.screenMaterial.map = texture;
      const fit = Math.min(SCREEN_WIDTH / video.videoWidth, SCREEN_HEIGHT / video.videoHeight);
      this.screenMesh.scale.set(video.videoWidth * fit, video.videoHeight * fit, 1);
    }
    this.screenMaterial.needsUpdate = true;
  }

  isVideoTextureUpdating() {
    return Boolean(this.videoTexture && this.videoTexture.version > 0 && !this.lastError);
  }

  private fail(message: string) {
    if (this.lastError === message) return;
    this.lastError = message;
    this.onReport({ fps: null, error: message });
  }

  private frame = (time: number) => {
    if (!this.running || this.disposed) return;
    const dt = Math.min(0.1, this.lastTime ? (time - this.lastTime) / 1000 : 0.016);
    this.lastTime = time;
    const ease = (rate: number) => 1 - Math.exp(-rate * dt);
    const xr = this.renderer.xr.isPresenting;

    this.rig.position.lerp(this.rigTarget, ease(4));
    if (!xr) {
      if (this.sensorQuaternion && this.sensorRecenter) {
        this.camera.quaternion.copy(this.sensorQuaternion).premultiply(this.sensorRecenter);
      } else {
        // Inertial look: the view eases toward where you dragged.
        this.yaw += (this.manualYaw - this.yaw) * ease(10);
        this.pitch += (this.manualPitch - this.pitch) * ease(10);
        this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
      }
      if (Math.abs(this.targetFov - this.fov) > 0.01) {
        this.fov += (this.targetFov - this.fov) * ease(8);
        this.camera.fov = this.fov;
        this.camera.updateProjectionMatrix();
      }
    }

    // House lights fade down while the film plays and come back up on pause.
    this.houseLevel += ((this.playing ? 0.22 : 1) - this.houseLevel) * ease(1.4);
    for (const { material, base } of this.dimmables) material.color.copy(base).multiplyScalar(0.25 + 0.75 * this.houseLevel);
    for (const { light, base } of this.fillLights) light.intensity = base * this.houseLevel;
    this.renderer.toneMappingExposure = 1.15 + 0.35 * this.houseLevel;

    this.sampleScreen(time);
    this.spillColor.lerp(this.spillTarget, ease(3));
    this.spillEnergy += (this.spillEnergyTarget - this.spillEnergy) * ease(3);
    const dark = 1 - this.houseLevel;
    this.screenLight.color.copy(this.spillColor);
    this.screenLight.intensity = this.spillEnergy * (25 + 110 * dark);
    this.spillLight.color.copy(this.spillColor);
    this.spillLight.intensity = this.spillEnergy * (10 + 50 * dark);
    this.beamMaterial.uniforms.uOpacity.value = 0.05 * dark * (0.5 + this.spillEnergy);
    this.dustMaterial.opacity = 0.55 * dark;
    this.dust.rotation.z = Math.sin(time * 0.00005) * 0.01;
    this.dust.position.y = Math.sin(time * 0.0002) * 0.08;
    const placeholderInterval = this.quality === "low" ? 150 : this.quality === "medium" ? 100 : 66;
    if (!this.videoTexture && time - this.lastPlaceholderDraw > placeholderInterval) {
      this.paintPlaceholder(time);
      this.lastPlaceholderDraw = time;
    }
    try {
      if (xr) {
        this.renderer.render(this.scene, this.camera);
      } else if (this.stereo) {
        this.rig.updateMatrixWorld(true);
        this.stereoCamera.update(this.camera);
        const half = Math.floor(this.width / 2);
        this.renderer.setScissorTest(true);
        this.renderer.setViewport(0, 0, half, this.height);
        this.renderer.setScissor(0, 0, half, this.height);
        this.renderer.render(this.scene, this.stereoCamera.cameraL);
        this.renderer.setViewport(half, 0, this.width - half, this.height);
        this.renderer.setScissor(half, 0, this.width - half, this.height);
        this.renderer.render(this.scene, this.stereoCamera.cameraR);
        this.renderer.setScissorTest(false);
      } else {
        this.renderer.setViewport(0, 0, this.width, this.height);
        this.renderer.render(this.scene, this.camera);
      }
      if (++this.drawCount % 120 === 0 && this.renderer.getContext().getError() !== 0) {
        this.fail("The browser reported a WebGL rendering error.");
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "The scene could not render.");
      this.stop();
      return;
    }
    this.frames++;
    if (time - this.fpsWindow >= 1000) {
      this.onReport({ fps: Math.round((this.frames * 1000) / (time - this.fpsWindow)), error: this.lastError });
      this.frames = 0;
      this.fpsWindow = time;
    }
  };

  private start() {
    if (this.running || this.disposed || document.hidden) return;
    this.running = true;
    this.frames = 0;
    this.fpsWindow = performance.now();
    this.lastTime = 0;
    // setAnimationLoop drives both the page and WebXR headsets.
    this.renderer.setAnimationLoop(this.frame);
  }

  private stop() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
    this.onReport({ fps: null, error: this.lastError });
  }

  dispose() {
    this.disposed = true;
    this.artworkImage.onload = null;
    this.stop();
    void this.xrSession?.end().catch(() => undefined);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.resizeObserver.disconnect();
    this.videoTexture?.dispose();
    this.placeholderTexture.dispose();
    this.unitBox.dispose();
    this.roundedBox.dispose();
    this.reclinerBack.dispose();
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
    this.renderer.dispose();
  }
}
