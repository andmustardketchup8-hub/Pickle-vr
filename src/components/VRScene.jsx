import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { createHand } from "@/components/vr/createHand";
import { specFor } from "@/components/vr/maps";
import { createLoadingCard } from "@/components/vr/createLoadingCard";
import { createBootCard } from "@/components/vr/createBootCard";
import { startup } from "@/components/vr/startup/startupReport";
import { createSessionStart } from "@/components/vr/startup/createSessionStart";
import { createFade } from "@/components/vr/story/createFade";
import { quietPanel, quietTool } from "@/components/vr/quietParts";
import { createPedestal } from "@/components/vr/createPedestal";
import { createGun } from "@/components/vr/createGun";
import { createGunBody } from "@/components/vr/gunPhysics";
import { createMuzzleFlash } from "@/components/vr/createMuzzleFlash";
import { createShotSound } from "@/components/vr/createShotSound";
import { createActionSound } from "@/components/vr/actionSounds";
import { createHitSound } from "@/components/vr/createHitSound";
import { createWeaponAction } from "@/components/vr/weaponAction";
import { weaponFor, WEAPONS } from "@/components/vr/weaponCatalog";
import { createWeaponRack } from "@/components/vr/createWeaponRack";
import { createMirror, beginMirrorFrame } from "@/components/vr/createMirror";
import { createPickleAvatar } from "@/components/vr/createPickleAvatar";
import { createPropGrabber } from "@/components/vr/propGrabber";
import { createLocomotion, DEFAULT_MOVEMENT } from "@/components/vr/locomotion";
import MovementSettings from "@/components/vr/MovementSettings";
import { createWeaponHud } from "@/components/vr/createWeaponHud";
import { createGloveMenu } from "@/components/vr/createGloveMenu";
import { loadGloveStyle, saveGloveStyle } from "@/components/vr/gloveStyles";
import { createHaptics } from "@/components/vr/haptics";
import { firingFor } from "@/components/vr/gunFiring";
import { createHipMagazines } from "@/components/vr/hipMagazines";
import { createNpcCrowd } from "@/components/vr/npcCrowd";
import { createSpawnerPanel } from "@/components/vr/createSpawnerPanel";
import { createSpawnerTool } from "@/components/vr/createSpawnerTool";
import { createStoryDirector } from "@/components/vr/story/storyDirector";
import { chapterFor } from "@/components/vr/story/chapters";
import { createLobby } from "@/components/vr/lobby/createLobby";
import { createLobbyReturn } from "@/components/vr/lobby/createLobbyReturn";
import { createPointer } from "@/components/vr/lobby/createPointer";
import { LOBBY_VIEW, lobbyMapName } from "@/components/vr/lobby/lobbyMaps";

/*
  Maps the hand's local frame into the WebXR grip frame.

  Grip frame: -Z points along the controller, +Y is up the handle.
  A hand holding that handle has the fingers pointing forward along -Z, the back
  of the hand facing outward and the thumb up, palm wrapped inward.

  Hand local: +X = thumb side · +Y = back of the hand · -Z = fingers.
  So local X maps to down (the thumb sits on the opposite side), local Y maps to
  the outward side, and local Z maps to back — which puts the fingers on -Z.
*/
const HAND_BASIS = {
  right: [
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ],
  left: [
    [0, 1, 0],
    [-1, 0, 0],
    [0, 0, 1],
  ],
};

const quaternionFromBasis = (basis) =>
  new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...basis[0]),
      new THREE.Vector3(...basis[1]),
      new THREE.Vector3(...basis[2])
    )
  );

export default function VRScene({
  map = "room",
  story = null,
  storyCheckpoint = null,
  difficulty = "normal",
  onStoryCheckpoint,
  onStoryComplete,
  onStoryNext,
  onExitToMenu,
  onLobbySelect,
  onReturnToLobby,
  movement,
  onMovementChange,
}) {
  const canvasRef = useRef(null);
  const enterRef = useRef(null);
  const spawnRef = useRef(null);
  const menuRef = useRef(null);
  const engineRef = useRef(null);
  const callbacks = useRef({});
  const [status, setStatus] = useState("checking");
  const [message, setMessage] = useState("Checking for a headset…");

  // The lobby is a world of its own rather than a map: it offers the maps.
  const lobbyMode = map === "lobby";

  // Read inside the animation loop, so tuning movement never rebuilds the world.
  const settingsRef = useRef(movement || DEFAULT_MOVEMENT);
  useEffect(() => {
    if (movement) settingsRef.current = movement;
  }, [movement]);

  // The latest callbacks, so a world built once can still reach them.
  useEffect(() => {
    callbacks.current = {
      onExitToMenu,
      onStoryCheckpoint,
      onStoryComplete,
      onStoryNext,
      onLobbySelect,
      onReturnToLobby,
    };
  });

  /*
    The renderer, the scene, the camera and the headset session belong to the
    page, not to a map. They are built once and outlive every map swap, which is
    what lets the player move from one chapter's map to the next without the
    session ever ending.
  */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    } catch (error) {
      setStatus("error");
      setMessage("WebGL could not start on this device.");
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType("local-floor");
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070a0d);

    const camera = new THREE.PerspectiveCamera(62, 1, 0.02, 60);

    // The blackout and the loading card ride the camera, so a map swap still has
    // something to show inside the session.
    const fade = createFade();
    camera.add(fade.root);
    const loadingCard = createLoadingCard();
    camera.add(loadingCard.root);

    /*
      The startup, reported where it can actually be seen. A page overlay and the
      console are both invisible inside a headset, so without this card a failure
      there is a black screen and nothing else to go on. Anything that throws —
      here, while a map is built, or inside the animation loop — is printed on it.
    */
    const boot = createBootCard();
    camera.add(boot.root);

    const report = (error) => {
      boot.fail(error);
      startup.fail(error);
      // A blackout left at full opacity is a black screen of its own.
      fade.fadeTo(0, 0.2);
    };

    /*
      The startup's own record, fed to the card. Both the card in the headset and
      the flat overlay the packaged app shows read this one place, so they can
      never disagree about how far the load got.
    */
    startup.reset();
    let reportedError = "";
    const unsubscribeStartup = startup.subscribe((state) => {
      boot.progress(state.progress, state.label);
      if (state.error && state.error !== reportedError) {
        reportedError = state.error;
        boot.fail(new Error(state.error));
      }
    });

    const onError = (event) => report(event.error || event.message);
    const onRejection = (event) => report(event.reason);

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    boot.stage("WebGL renderer created");

    const gl = renderer.getContext();
    if (gl) {
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      const name = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      boot.stage(`GPU: ${String(name).slice(0, 46)}`);
      boot.stage(`WebGL ${gl.getParameter(gl.VERSION)}`);
    }

    const grips = [];
    const controllers = { left: null, right: null };

    const engine = {
      renderer,
      scene,
      camera,
      fade,
      loadingCard,
      boot,
      grips,
      controllers,
      restoreView: null,
      unlockAudio: null,
    };
    engineRef.current = engine;

    /*
      A loop of the engine's own, running before any world exists.

      The world replaces it once it is built, but if building a world throws, this
      one is still running — so the boot card, with the error on it, is what the
      headset shows instead of a black screen.
    */
    let bootOnly = true;
    renderer.setAnimationLoop(() => {
      if (!bootOnly) return;
      renderer.render(scene, camera);
    });

    for (let i = 0; i < 2; i++) {
      const grip = renderer.xr.getControllerGrip(i);

      grip.addEventListener("connected", (event) => {
        const source = event.data;
        grip.userData.inputSource = source;
        if (source.handedness === "left" || source.handedness === "right") {
          controllers[source.handedness] = grip;
        }
      });

      grip.addEventListener("disconnected", () => {
        grip.userData.inputSource = null;
        if (controllers.left === grip) controllers.left = null;
        if (controllers.right === grip) controllers.right = null;
      });

      grips.push(grip);
    }

    const resize = () => {
      /*
        A packaged app has no page layout to be measured in and can report a
        zero-sized viewport. Without a fallback the renderer is then never sized,
        nothing is drawn, and the screen stays black for a reason that has
        nothing to do with the game.
      */
      const screenSize = window.screen || {};
      const width = canvas.clientWidth || window.innerWidth || screenSize.width || 1280;
      const height = canvas.clientHeight || window.innerHeight || screenSize.height || 720;
      if (!width || !height) return;
      /*
        The packaged host has no layout engine, so the canvas can report no box
        at all. Without one the drawing buffer is never sized and nothing is
        drawn, whatever the scene holds — so give the element an explicit box.
      */
      if (!canvas.clientWidth && !canvas.clientHeight && canvas.style) {
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    resize();
    window.addEventListener("resize", resize);

    /*
      The session is asked for by a manager of its own — `startup/createSessionStart.js`
      explains why in full. What matters here: it never waits forever on a held
      request, never asks twice at once, and hands back a session the headset
      never shows instead of drawing into it.
    */
    const sessionStart = createSessionStart({
      renderer,
      onStatus: setStatus,
      onMessage: setMessage,
      onSessionLost: () => {
        // three drops its XR loop with the session; the world's own takes over.
        if (engine.restoreView) engine.restoreView();
        if (engine.restartLoop) engine.restartLoop();
      },
    });
    engine.sessionStart = sessionStart;

    /*
      Asked for immediately, at mount.

      The packaged host holds a request made before its own OpenXR session has
      begun, and opens it on the state event that says it has — so asking early
      costs nothing and buys the whole startup. It matters because the headset
      shows the launch splash until the app presents its first frame, and on the
      headset a flat page is never composited at all: an app that has not asked
      yet is an app with nothing on screen.

      `enterRef` is the manual way in — a tap on the scene, or the button on the
      page — and it was never assigned, so a refused automatic request left the
      game with no way to start a session at all.
    */
    boot.stage("Waiting for the headset…");
    enterRef.current = () => sessionStart.retry();
    sessionStart.begin(0);

    return () => {
      sessionStart.stop();
      unsubscribeStartup();
      enterRef.current = null;
      engineRef.current = null;
      window.removeEventListener("resize", resize);
      renderer.setAnimationLoop(null);
      camera.remove(fade.root);
      fade.dispose();
      camera.remove(loadingCard.root);
      loadingCard.dispose();
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      camera.remove(boot.root);
      boot.dispose();
      renderer.dispose();
    };
  }, []);

  /*
    The world: everything that belongs to the map being played, rebuilt when the
    map changes and torn down when it is left. The engine above keeps running.
  */
  useEffect(() => {
    const canvas = canvasRef.current;
    const engine = engineRef.current;
    if (!canvas || !engine) return;

    const { renderer, scene, camera } = engine;
    const spec = lobbyMode ? { name: "Lobby", view: LOBBY_VIEW } : specFor(map);

    // The bar moves on what actually happened, step by step.
    startup.step("world", `Building ${spec.name}`, 0.45, lobbyMode ? "lobby" : map);

    // Story worlds and the lobby are played without the sandbox's weapons and tools.
    const storyMode = Boolean(story);
    const playground = !storyMode && !lobbyMode;

    // Each world brings its own air; the scene itself lives with the page.
    scene.fog = new THREE.Fog(0x070a0d, 7, 15);

    const view = spec.view || { eye: [0, 1.5, 0.95], look: [0, 1.22, -0.5] };
    camera.position.set(...view.eye);
    camera.lookAt(...view.look);
    engine.restoreView = () => {
      camera.position.set(...view.eye);
      camera.lookAt(...view.look);
    };

    // The player rig: the camera and both controller grips hang off it, so moving
    // or turning it carries the head and hands together. The headset's own pose
    // is applied on top of the rig. A fresh rig per map is what puts the player
    // at that map's spawn.
    const player = new THREE.Group();
    player.name = "player-rig";
    scene.add(player);
    player.add(camera);

    // The grips are the page's, so a swap re-parents them rather than losing the
    // controllers the player is holding.
    for (const grip of engine.grips) player.add(grip);

    /*
      Every map comes from the registry, so a map added there is playable here;
      the lobby is the one world that is not a map.

      A scene that throws while it is being built used to take the whole page
      down with it: the effect threw, React unmounted the tree, and the headset
      was left with a black rectangle and no reason for it. Now the failure is
      caught, named on the card, and the startup stops at the step that failed
      instead of pretending to carry on.
    */
    let environment = null;

    try {
      environment = lobbyMode
        ? createLobby({
            renderer,
            onSelect: (id) => {
              // Black out first, then swap; the chosen world fades itself back in.
              engine.fade.fadeTo(1, 0.3);
              engine.loadingCard.show(lobbyMapName(id));
              window.setTimeout(() => {
                const selectMap = callbacks.current.onLobbySelect;
                if (selectMap) selectMap(id);
              }, 340);
            },
          })
        : spec.build();
    } catch (error) {
      const detail = (error && (error.message || error.name)) || String(error);
      startup.fail(new Error(`${spec.name} could not be built — ${detail}`));
      return;
    }

    if (!environment || !environment.group) {
      startup.fail(new Error(`${spec.name} built nothing to show.`));
      return;
    }

    scene.add(environment.group);
    if (environment.sky) scene.background = environment.sky;
    if (environment.fog) scene.fog = environment.fog;

    startup.step("world", `${spec.name} built`, 0.7, "");

    // Only the range has anything to shoot at.
    const targets = environment.targets || null;

    // Walkable area of the map, shared by the player and the guns' physics.
    const bounds = environment.bounds ?? { halfWidth: 2.45, halfDepth: 2.45 };

    const pedestal = playground ? createPedestal() : null;
    if (pedestal) scene.add(pedestal.group);

    /*
      The testing room keeps every weapon on a rack along its right wall, each on
      its own name plate at grabbing height. The other maps have no walls, so
      there the guns lie on the bench as before.
    */
    const rack =
      playground && map === "room"
        ? createWeaponRack({
            items: Object.values(WEAPONS).map((weapon) => ({ kind: weapon.kind, name: weapon.name })),
          })
        : null;
    if (rack) scene.add(rack.group);

    /*
      The NPC tool stands on the bench between the two guns. It is picked up and
      carried exactly like them, but it only ever places characters. A story
      world carries none of that, so the same loop runs against quiet stand-ins.
    */
    const spawnerTool = playground ? createSpawnerTool({ pedestal, bounds }) : quietTool();
    if (playground) {
      scene.add(spawnerTool.root);
      scene.add(spawnerTool.mount);
    }

    // Everything solid the player and the NPCs have to walk around.
    const solid = [
      ...(pedestal ? [{ x: 0, z: pedestal.spawn.z, radius: 0.8 }] : []),
      ...(environment.obstacles || []),
    ];

    /*
      The way back out of any world: a plate beside the player's spawn that
      returns them to the lobby. The lobby itself has no such plate — it is
      where the plate leads.
    */
    const leaveToLobby = () => {
      engine.fade.fadeTo(1, 0.3);
      engine.loadingCard.show("Lobby");
      window.setTimeout(() => {
        const back = callbacks.current.onReturnToLobby;
        if (back) back();
      }, 340);
    };

    const lobbyReturn = lobbyMode ? null : createLobbyReturn({ onSelect: leaveToLobby });

    if (lobbyReturn) {
      const [eyeX, eyeY, eyeZ] = view.eye;
      const [lookX, , lookZ] = view.look;
      const span = Math.hypot(lookX - eyeX, lookZ - eyeZ) || 1;
      const forwardX = (lookX - eyeX) / span;
      const forwardZ = (lookZ - eyeZ) / span;
      // Right vector of the spawn view, so the plate always sits to the player's right.
      const rightX = -forwardZ;
      const rightZ = forwardX;

      lobbyReturn.group.position.set(
        eyeX + forwardX * 0.9 + rightX * 0.6,
        eyeY - 0.34,
        eyeZ + forwardZ * 0.9 + rightZ * 0.6
      );
      lobbyReturn.group.lookAt(eyeX, eyeY - 0.34, eyeZ);
      scene.add(lobbyReturn.group);
    }

    /*
      The lobby's tiles are its only controls, so each hand carries a visible
      laser: without it a player cannot tell what a trigger is about to press.
    */
    const lobbyPointer = lobbyMode ? createPointer() : null;
    if (lobbyPointer) scene.add(lobbyPointer.root);

    // Thumbstick locomotion for the player rig.
    const locomotion = createLocomotion({
      player,
      bounds,
      zones: environment.zones,
      obstacles: solid,
    });

    // The body rides the rig too, so locomotion carries it exactly.
    const avatar = createPickleAvatar();
    player.add(avatar.group);

    const propGrabber = createPropGrabber();
    const mirrors = [];

    /*
      Sound is the one subsystem a host can legitimately refuse to build — no
      audio device, or a runtime without Web Audio. A silent game is playable; a
      world that never finished building is not, so each falls back to silence
      instead of taking the map down with it.
    */
    const silence = () => ({ play: () => {}, unlock: () => {}, update: () => {}, dispose: () => {} });
    const sound = (build) => {
      try {
        return build();
      } catch (error) {
        engine.boot.stage(`Audio unavailable: ${(error && (error.message || error.name)) || "unknown"}`);
        return silence();
      }
    };

    const shot = sound(createShotSound);
    const actionSound = sound(createActionSound);
    const hitSound = sound(createHitSound);
    const haptics = createHaptics();

    let disposed = false;

    /*
      Both guns stand on the bench, one each side — except in the testing room,
      where they hang on the wall rack. Each keeps its own physics body, muzzle
      flash, recoil and the hand holding it, so they can be used at the same
      time — one in each hand.
    */
    const guns = [];

    const loadGun = async (kind, offsetX, anchor) => {
      const loaded = await createGun(kind);
      if (disposed) {
        loaded.dispose();
        return;
      }

      if (anchor) {
        // Hung on the rack: turned to face the room, its body centred on its place.
        loaded.root.quaternion.copy(anchor.quaternion);
        loaded.root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(loaded.root);
        loaded.root.position.copy(anchor.position).sub(box.getCenter(new THREE.Vector3()));
      } else {
        loaded.root.position.copy(pedestal.spawn);
        loaded.root.position.x += offsetX;
      }
      scene.add(loaded.root);

      // Where the gun waits while it is not in a hand — its place on the rack,
      // or on the bench, which is also where Y / B stows it back to.
      const home = {
        position: loaded.root.position.clone(),
        quaternion: loaded.root.quaternion.clone(),
      };

      // A full magazine to start with, and the capacity it refills to.
      const capacity = firingFor(kind).capacity;

      const body = createGunBody({ root: loaded.root, pedestal, room: bounds });
      // A gun hanging on the rack stays there until a hand takes it.
      if (anchor) body.rest();

      guns.push({
        kind,
        // The item's own identity, kept with the gun so it survives every
        // pickup, drop and stow: the inventory reads this, never the model name.
        id: weaponFor(kind).id,
        root: loaded.root,
        home,
        muzzle: loaded.muzzle,
        magwell: loaded.magwell,
        // Where a support hand takes hold to work the action.
        action: loaded.action,
        // The part that actually moves — the slide or the pump — and its travel.
        slide: loaded.slide,
        slideTravel: loaded.slideTravel,
        grip: loaded.grip,
        dispose: loaded.dispose,
        flash: createMuzzleFlash(loaded.muzzle),
        body,
        heldBy: null,
        recoil: 0,
        cooldown: 0,
        // Set when a magazine seats: the gun then works its action.
        cycle: 0,
        // True from the moment a magazine starts going in until the action has
        // run fully home: the whole time the gun refuses to fire.
        seating: false,
        reloading: false,
        // Whether the gun is charged and will fire. Every gun comes off the
        // bench cold: its action has to be worked by hand first.
        ready: false,
        capacity,
        ammo: capacity,
        grabBlend: 1,
        // Where the gun should sit while held, and the pose it is pulled from
        // so a grab never snaps it across the room.
        grabFrom: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
        gripTarget: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
      });
    };

    if (playground) {
      Promise.all([
        loadGun("pistol", -0.45, rack ? rack.anchors.pistol : null),
        loadGun("shotgun", 0.45, rack ? rack.anchors.shotgun : null),
      ])
        .then(() => startup.step("assets", "Weapon models loaded", 0.85, ""))
        .catch((error) => {
          // A model that will not load is reported and stepped over: the map is
          // still playable without it.
          const detail = (error && (error.message || error.name)) || "unknown error";
          startup.step("assets", "Weapon model unavailable", 0.85, detail);
          setMessage("A gun model could not be loaded — the map still works.");
        });
    }

    // The mirror is a spawned prop: grab it and park it anywhere in the map.
    spawnRef.current = () => {
      const mirror = createMirror();
      const column = mirrors.length % 3;
      const row = Math.floor(mirrors.length / 3);
      mirror.group.position.set(0.95 + column * 0.85, 0, -1.5 - row * 0.6);
      mirror.group.rotation.y = -0.6;
      scene.add(mirror.group);
      // Reach for the glass, a metre up, not the base on the floor.
      propGrabber.add(mirror.group, 1.0);
      mirrors.push(mirror);
    };

    // One mirror is already in the world, so it is there inside the headset too.
    if (playground) spawnRef.current();

    // The gloves come back the way they were left last time.
    let gloveStyle = loadGloveStyle();

    const hands = {
      left: createHand({ handedness: "left", gloveStyle }),
      right: createHand({ handedness: "right", gloveStyle }),
    };
    // Hands ride the rig with their controllers, so they never come loose.
    player.add(hands.left.root);
    player.add(hands.right.root);

    // Both hands always wear the same gloves.
    const applyGlove = (next) => {
      gloveStyle = next;
      hands.left.setGloveStyle(next);
      hands.right.setGloveStyle(next);
      gloveMenu.setStyle(next);
      saveGloveStyle(next);
    };

    const gloveMenu = createGloveMenu({
      style: gloveStyle,
      onSelect: applyGlove,
    });
    scene.add(gloveMenu.root);

    /*
      NPCs are built from the player's own pickle: the avatar group is the
      template, so every character has the same body, skin and face, and cloning
      it shares the geometry and materials instead of uploading them again.
    */
    const npcCrowd = createNpcCrowd({ template: avatar.group, scene });

    // Where the emitter meets the floor: the spot a new character appears on.
    const aimPoint = new THREE.Vector3();

    const placeNpc = (preset) => {
      spawnerTool.aim(aimPoint, headPosition);
      const npc = npcCrowd.spawnAt({
        point: aimPoint,
        preset,
        behavior: spawnerPanel.behavior(),
        bounds,
        obstacles: solid,
      });
      if (!npc) return false;

      // The tool's own indicator flares where it placed someone.
      spawnerTool.flash();
      return true;
    };

    const spawnerPanel = !playground
      ? quietPanel()
      : createSpawnerPanel({
          onDelete: () => {
            spawnerTool.aim(aimPoint, headPosition);
            npcCrowd.removeNearest(spawnerTool.heldBy ? aimPoint : headPosition);
          },
          // One switch for the whole crowd, and for whatever is spawned next.
          onBehavior: (mode) => npcCrowd.setBehavior(mode),
        });

    // The panel is a small plate on the tool itself, leaning back at the player.
    // Raised with the panel's extra row of characters.
    if (playground) {
      spawnerPanel.root.position.set(0, 0.15, 0.055);
      spawnerPanel.root.rotation.set(-0.6, 0, 0);
      spawnerPanel.root.scale.setScalar(0.9);
      spawnerTool.root.add(spawnerPanel.root);
    }

    /*
      Story Mode rides on top of whichever map is loaded: the same world, hands,
      guns and characters, plus one chapter's props, mission and objectives. With
      no chapter given — the sandbox — none of this exists at all.
    */
    const storyLayer = story
      ? createStoryDirector({
          chapter: chapterFor(story),
          scene,
          camera,
          npcCrowd,
          bounds,
          obstacles: solid,
          checkpoint: storyCheckpoint,
          difficulty,
          onCheckpoint: (state) => onStoryCheckpoint && onStoryCheckpoint(story, state),
          onComplete: (id) => onStoryComplete && onStoryComplete(id),
          onNext: (id) => onStoryNext && onStoryNext(id),
          onExit: () => onExitToMenu && onExitToMenu(),
          onPulse: (strength) => {
            for (const side of ["left", "right"]) {
              const controller = controllers[side];
              const source = controller && controller.userData.inputSource;
              if (source) haptics.pulse(source, strength, 45);
            }
          },
        })
      : null;

    // The flat preview has no hand to hold the tool, so a button pins the panel.
    let panelPinned = false;

    menuRef.current = {
      toggle: () => gloveMenu.toggle(headPosition, headDirection),
      npcs: () => {
        panelPinned = !panelPinned;
      },
    };

    // The inventory slot is world geometry carried by the headset, so it stays
    // visible inside an immersive session where a page overlay would not.
    const weaponHud = createWeaponHud();
    camera.add(weaponHud.root);

    const offset = {
      left: quaternionFromBasis(HAND_BASIS.left),
      right: quaternionFromBasis(HAND_BASIS.right),
    };

    // Where the hands rest while looking at the page outside of VR.
    const restPose = {
      left: {
        position: new THREE.Vector3(-0.24, 1.25, -0.3),
        quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5, -0.25, 0, "YXZ")),
      },
      right: {
        position: new THREE.Vector3(0.24, 1.25, -0.3),
        quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.5, 0.25, 0, "YXZ")),
      },
    };

    // Wired once in the engine, so a map swap keeps the same controllers.
    const controllers = engine.controllers;

    /*
      Working a gun's action by hand. The support hand takes hold of the slide or
      the pump, pulls it back and lets it run home; every cue lands in the sound
      and in the controller at the same moment.
    */
    const weaponAction = createWeaponAction({
      onCue: (gun, phase, side, cocked) => {
        actionSound.play(gun.kind, phase);
        const source = controllers[side] && controllers[side].userData.inputSource;
        if (source) haptics.pulse(source, phase === "back" ? 0.5 : 0.7, phase === "back" ? 35 : 45);

        /*
          The action worked fully back and home is the one thing that readies a
          gun, so it becomes ready on that cue and only there — never because
          time passed. The trigger of the hand holding it is disarmed with it, so
          a pull that was already down cannot fire the shot.
        */
        if (phase === "home" && cocked) {
          gun.ready = true;
          if (gun.heldBy) triggerArmed[gun.heldBy] = false;
        }
      },
    });

    // The grips ride the rig; their listeners were wired once in the engine.

    /*
      Spare magazines ride on the belt: take one and seat it into the matching
      gun in the other hand to fill that gun again.
    */
    const hipMagazines = createHipMagazines({
      onInsert: (_gun, side) => {
        const source = controllers[side] && controllers[side].userData.inputSource;
        if (source) haptics.pulse(source, 0.7, 60);
      },
    });
    player.add(hipMagazines.root);

    // Each controller's pose in world space, rebuilt from the rig every frame so
    // grabbing stays accurate once the player walks and turns.
    const controllerPose = {
      left: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), connected: false },
      right: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), connected: false },
    };

    // xr-standard gamepads report the thumbstick on axes 2 and 3.
    const readSticks = () => {
      let moveX = 0;
      let moveY = 0;
      let turn = 0;

      for (const side of ["left", "right"]) {
        const controller = controllers[side];
        const source = controller && controller.userData.inputSource;
        const gamepad = source && source.gamepad;
        if (!gamepad || !gamepad.axes || gamepad.axes.length < 2) continue;

        const wide = gamepad.axes.length >= 4;
        const x = (wide ? gamepad.axes[2] : gamepad.axes[0]) || 0;
        const y = (wide ? gamepad.axes[3] : gamepad.axes[1]) || 0;

        if (side === "left") {
          moveX = x;
          moveY = -y; // pushing up is negative on the stick
        } else {
          turn = x;
        }
      }

      return { moveX, moveY, turn };
    };

    // The hands start empty in every new world.


    const clock = new THREE.Clock();
    // The loading card holds while the blackout lifts, then lets go.
    let loadingHold = 0.4;
    // When this world started, so a blackout that outlives the load can be dropped.
    const worldStartedAt = performance.now();
    // Set by the first frame this world draws, which is what closes the boot card.
    let firstFrame = false;
    let frameCount = 0;
    // Sound is unlocked by the first frame that arrives inside a session.
    let audioUnlocked = false;
    let lastStatus = -1;
    // The lobby turns itself to face its tiles on the first frame in a session.
    let lobbyAligned = false;
    const previousGrip = { left: 0, right: 0 };
    const previousTrigger = { left: 0, right: 0 };
    // A trigger only counts once it has been let go since the last shot, so a
    // pull held through a reload can never set the gun off when it finishes.
    const triggerArmed = { left: true, right: true };
    // Fed to the story every frame, so a lever can be held rather than tapped.
    const triggerValues = { left: 0, right: 0 };
    const previousMenuButton = { left: 0, right: 0 };
    const previousStowButton = { left: 0, right: 0 };
    const previousPosition = { left: new THREE.Vector3(), right: new THREE.Vector3() };
    const controllerVelocity = { left: new THREE.Vector3(), right: new THREE.Vector3() };
    const headPosition = new THREE.Vector3();
    const headDirection = new THREE.Vector3();
    const headLocal = new THREE.Vector3();
    const headLocalQuaternion = new THREE.Quaternion();
    const headForward = new THREE.Vector3();

    const frame = () => {
      const dt = Math.min(clock.getDelta(), 0.05);
      const presenting = renderer.xr.isPresenting;

      /*
        A session that comes up after the world was built starts with the sound
        still locked: the world unlocked it at build time only if a session was
        already running then. The first frame that arrives inside a session
        unlocks it, once.
      */
      if (presenting && !audioUnlocked && engine.unlockAudio) {
        audioUnlocked = true;
        engine.unlockAudio();
      }

      /*
        The headset's own pose, copied onto the page camera every frame.

        Inside a session three renders with an XR camera of its own and never
        touches this one — but everything that rides it does. The blackout, the
        loading card, the startup card and the weapon HUD are its children, and
        the whole game reads the head off it: the body, the walking direction, the
        turn pivot, the mission tracker, the crowd.

        Left alone it stays at the map's page-view pose, which inside a session is
        a fixed spot in the room — so the cards land somewhere the player cannot
        look, and every head-relative calculation is measured from a viewpoint
        nobody is standing at. Copying the XR camera's pose here fixes all of it
        at once, because that pose is already expressed in the player rig's own
        frame, which is the frame the rest of this function works in.
      */
      if (presenting) {
        const xrCamera = renderer.xr.getCamera();
        if (xrCamera && Number.isFinite(xrCamera.position.x) && Number.isFinite(xrCamera.quaternion.w)) {
          camera.position.copy(xrCamera.position);
          camera.quaternion.copy(xrCamera.quaternion);
        }
      }

      /*
        A session that presents without view poses is NOT recovered here.

        It used to be: three draws nothing into a session with no views, so after
        three seconds the session was handed back and asked for again. That is
        exactly backwards on this host. A session opened while the runtime is
        READY or SYNCHRONIZED is hidden BY DESIGN and carries no views until the
        runtime reaches VISIBLE or FOCUSED — and handing it back returns the app
        to flat frames, which the headset never composites, with the host's
        autoEnter already spent. The result was a black screen that stayed black.

        The session manager keeps the session and waits for the host to make it
        visible. The numbers below still report the view count, so a session that
        really never presents shows up as `views 0` on the card.
      */

      /*
        The blackout rides the camera, so it is stepped before anything else in
        the frame — and it can never outlive the load. A blackout left up is a
        black screen, so once the world has been up for a few seconds it is
        dropped outright rather than waiting on a fade that may never finish.
      */
      if (performance.now() - worldStartedAt > 3000 && engine.fade.opacity() > 0.01) {
        engine.fade.clear();
      }
      engine.fade.update(dt);

      /*
        The head pose, in the rig's own frame.

        The renderer writes the XR pose into this camera as a transform *inside
        the rig*, and leaves the page-view pose there outside a session, so this
        is the player's true offset from the player root in both modes.

        Asking the XR camera for a world position instead is what broke tracking:
        it is a parentless object, so a world read rewrites its world matrix with
        the raw reference-space pose. The head was then measured in reference
        space and subtracted from a moved rig, which dragged the body away from
        the player the moment the rig walked or turned.
      */
      headLocal.copy(camera.position);
      headLocalQuaternion.copy(camera.quaternion);

      /*
        The lobby opens with the tiles ahead of the player, whichever way the
        headset happens to be facing when the session starts. Without this the
        first thing a player sees is a bare wall of a dark room — which reads as
        a broken game rather than as a lobby.
      */
      if (lobbyMode && !lobbyAligned && presenting) {
        const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(headLocalQuaternion);
        player.rotation.y = Math.PI - Math.atan2(facing.x, facing.z);
        player.updateMatrixWorld(true);
        lobbyAligned = true;
      }

      // The same pose in world space, carried by the rig as it stands now.
      headPosition.copy(headLocal).applyMatrix4(player.matrixWorld);
      headDirection
        .set(0, 0, -1)
        .applyQuaternion(headLocalQuaternion)
        .applyQuaternion(player.quaternion)
        .normalize();

      const sticks = readSticks();
      locomotion.update(dt, {
        head: headPosition,
        direction: headDirection,
        moveX: sticks.moveX,
        moveY: sticks.moveY,
        turn: sticks.turn,
        settings: settingsRef.current,
      });

      // Fold the new rig transform into the world matrices before the renderer
      // reads them for the XR camera, so head and hands never drift apart.
      player.updateMatrixWorld(true);

      // The same head pose again, now carried by the rig it just moved.
      headPosition.copy(headLocal).applyMatrix4(player.matrixWorld);
      headDirection
        .set(0, 0, -1)
        .applyQuaternion(headLocalQuaternion)
        .applyQuaternion(player.quaternion)
        .normalize();

      for (const side of ["left", "right"]) {
        const hand = hands[side];
        const controller = controllers[side];
        const source = controller && controller.userData.inputSource;

        let trigger = 0;
        let squeeze = 0;
        let stowPressed = false;

        const pose = controllerPose[side];
        pose.connected = false;

        if (presenting && source) {
          hand.root.visible = true;
          // The grip pose is already the centre of the palm, so the pose is
          // copied straight through — no tracking offset, no smoothing lag.
          hand.root.position.copy(controller.position);
          hand.root.quaternion.multiplyQuaternions(controller.quaternion, offset[side]);

          // Same pose lifted into world space, for anything the hand touches.
          pose.connected = true;
          pose.position.copy(controller.position).applyQuaternion(player.quaternion).add(player.position);
          pose.quaternion.multiplyQuaternions(player.quaternion, controller.quaternion);

          const gamepad = source.gamepad;
          if (gamepad && gamepad.buttons.length > 1) {
            trigger = gamepad.buttons[0]?.value || 0;
            squeeze = gamepad.buttons[1]?.value || 0;
          }

          /*
            Two face buttons, one job each. In the xr-standard mapping index 4
            is A (right) / X (left) and index 5 is B (right) / Y (left) — index
            3 is the thumbstick click, which belongs to walking, not to the
            inventory. So the lower button opens the glove menu and the upper
            one stows what that hand holds.
          */
          const buttons = gamepad && gamepad.buttons;
          const stowButton = buttons && buttons[5]?.pressed ? 1 : 0;
          const menuButton = buttons && buttons[4]?.pressed ? 1 : 0;

          stowPressed = Boolean(stowButton && !previousStowButton[side]);
          previousStowButton[side] = stowButton;

          if (menuButton && !previousMenuButton[side]) {
            // A / X closes whichever panel is open, and opens the glove menu
            // when there is nothing on screen.
            if (spawnerPanel.isOpen()) spawnerPanel.setOpen(false);
            else gloveMenu.toggle(headPosition, headDirection);
          }
          previousMenuButton[side] = menuButton;

          // Tracked per frame so a released pistol inherits the throw.
          controllerVelocity[side]
            .subVectors(pose.position, previousPosition[side])
            .divideScalar(Math.max(dt, 0.001))
            .clampLength(0, 6);
          previousPosition[side].copy(pose.position);
        } else if (presenting) {
          hand.root.visible = false;
        } else {
          hand.root.visible = true;
          hand.root.position.copy(restPose[side].position);
          hand.root.quaternion.copy(restPose[side].quaternion).multiply(offset[side]);
        }

        // A menu owns the trigger while a ray is resting on one of its rows.
        const menuUsed = gloveMenu.track(side, pose, trigger > 0.5 && previousTrigger[side] <= 0.5);
        const panelUsed = spawnerPanel.track(side, pose, trigger > 0.5 && previousTrigger[side] <= 0.5);
        // The lobby plate takes the press before anything in the world does.
        const returnUsed = lobbyReturn
          ? lobbyReturn.track(side, pose, trigger > 0.5 && previousTrigger[side] <= 0.5)
          : false;

        /*
          The lobby's map tiles. Point a controller at one and pull the trigger:
          the beam ends on the button under the hand and turns green over it, and
          the tile answers in the same green as the press lands.
        */
        let lobbyUsed = false;
        if (lobbyPointer) {
          const aim = environment.track(
            side,
            pose,
            trigger > 0.5 && previousTrigger[side] <= 0.5
          );
          lobbyUsed = aim.pressed;
          lobbyPointer.aim(
            side,
            pose.connected ? pose.position : null,
            pose.quaternion,
            aim.distance
          );
        }

        // The gun, or the NPC tool, this hand is already holding.
        const heldGun = guns.find((entry) => entry.heldBy === side) || null;
        const heldTool = spawnerTool.heldBy === side;
        const heldNpc = npcCrowd.holding(side);

        /*
          Y / B puts the gun in that hand back into the inventory: it leaves the
          hand and returns to its place on the bench, ready to be taken again.
        */
        if (stowPressed && heldGun) {
          heldGun.heldBy = null;
          heldGun.recoil = 0;
          heldGun.cooldown = 0;
          heldGun.root.position.copy(heldGun.home.position);
          heldGun.root.quaternion.copy(heldGun.home.quaternion);
          heldGun.body.rest();
          if (source) haptics.pulse(source, 0.5, 40);
        }

        // The NPC tool goes back to its own place on the bench the same way.
        if (stowPressed && heldTool) {
          spawnerTool.stow();
          if (source) haptics.pulse(source, 0.5, 40);
        }

        if (controller && source) {
          /*
            Squeeze picks up what is in reach, in that order: the action of the
            gun held in the other hand, a free gun on the bench, or the magazine
            on that side of the belt.
          */
          const reaching = squeeze > 0.55 && previousGrip[side] <= 0.55;

          if (
            reaching &&
            !heldGun &&
            !heldTool &&
            !heldNpc &&
            !propGrabber.isHolding(side) &&
            !hipMagazines.holding(side) &&
            !weaponAction.holding(side, guns)
          ) {
            // The NPC tool comes first: it stands between the two guns, so a
            // hand on it takes it like any other tool. Then the slide or pump of
            // the gun in the other hand, which is the closest thing to a hand
            // already on the gun.
            if (
              playground &&
              !spawnerTool.heldBy &&
              pose.position.distanceTo(spawnerTool.root.position) < 0.3
            ) {
              spawnerTool.grab(side);
              haptics.pulse(source, 0.75, 50);
            } else if (weaponAction.tryGrab(side, pose.position, guns)) {
              haptics.pulse(source, 0.35, 25);
            } else {
              let nearest = null;
              // A hand's width either side of the grip, so a gun is taken by
              // walking up to it rather than by reaching out for it.
              let nearestDistance = 0.4;

              for (const candidate of guns) {
                if (candidate.heldBy) continue;
                const distance = pose.position.distanceTo(candidate.root.position);
                if (distance < nearestDistance) {
                  nearest = candidate;
                  nearestDistance = distance;
                }
              }

              if (nearest) {
                nearest.heldBy = side;
                // Straight off the bench it is ready to shoot: picking a gun up
                // is never what locks it, only a reload is.
                nearest.ready = true;
                nearest.recoil = 0;
                haptics.pulse(source, 0.85, 60);
                nearest.grabFrom.position.copy(nearest.root.position);
                nearest.grabFrom.quaternion.copy(nearest.root.quaternion);
                nearest.grabBlend = 0;
              } else if (npcCrowd.tryGrab(side, pose.position)) {
                haptics.pulse(source, 0.6, 45);
              } else if (hipMagazines.tryGrab(side, controller.position)) {
                haptics.pulse(source, 0.6, 45);
              }
            }
          } else if (heldGun && squeeze < 0.4 && previousGrip[side] >= 0.4) {
            heldGun.heldBy = null;
            haptics.pulse(source, 0.35, 30);
            heldGun.body.drop(controllerVelocity[side].clone().multiplyScalar(0.5), new THREE.Vector3());
          } else if (heldTool && squeeze < 0.4 && previousGrip[side] >= 0.4) {
            spawnerTool.release(controllerVelocity[side]);
            haptics.pulse(source, 0.35, 30);
          } else if (heldNpc && squeeze < 0.4 && previousGrip[side] >= 0.4) {
            // Let go of the character: it falls from where the hand left it.
            npcCrowd.release(side, controllerVelocity[side]);
            haptics.pulse(source, 0.35, 30);
          }

          // Letting go of a magazine puts it back on the belt.
          if (hipMagazines.release(side, squeeze, previousGrip[side])) {
            haptics.pulse(source, 0.3, 25);
          }

          // Letting go of a worked action springs it home.
          if (squeeze < 0.4 && previousGrip[side] >= 0.4 && weaponAction.release(side, guns)) {
            haptics.pulse(source, 0.3, 25);
          }

          // Releasing the trigger re-arms it; every pull is a single press.
          if (trigger < 0.4) triggerArmed[side] = true;
          const pressed = trigger > 0.5 && previousTrigger[side] <= 0.5;

          triggerValues[side] = trigger;

          /*
            Story Mode's one verb. The same trigger that fires a gun talks to a
            character, takes a power cell, seats it and works a control — and
            while a story message is on screen it turns the page instead.
          */
          if (
            storyLayer &&
            !menuUsed &&
            !panelUsed &&
            !returnUsed &&
            (storyLayer.isBlocking() || (!heldGun && !heldTool && !heldNpc))
          ) {
            storyLayer.press(side, pose, pressed);
          }

          /*
            The NPC tool's trigger places the selected character on the floor
            where the emitter points — one press each time, with a short cooldown
            so a held trigger cannot flood the sandbox.
          */
          if (
            heldTool &&
            !menuUsed &&
            !panelUsed &&
            triggerArmed[side] &&
            pressed &&
            spawnerTool.ready()
          ) {
            triggerArmed[side] = false;
            if (placeNpc(spawnerPanel.selection())) haptics.pulse(source, 0.55, 45);
          }

          /*
            Trigger fires the gun in that hand, on that gun's own terms: the
            pistol answers every pull, while the shotgun stays silent until its
            pump has been worked.

            A gun that is reloading — magazine still on its way in, or its slide
            or pump not yet home — does not fire at all, and a pull that began
            before it was ready is spent: the next shot needs a fresh press.
          */
          if (
            !menuUsed &&
            !panelUsed &&
            !returnUsed &&
            !lobbyUsed &&
            !(storyLayer && storyLayer.isBlocking()) &&
            heldGun &&
            heldGun.ready &&
            !heldGun.reloading &&
            heldGun.cooldown <= 0 &&
            triggerArmed[side] &&
            pressed
          ) {
            triggerArmed[side] = false;
            if (heldGun.ammo <= 0) {
              // Empty: the trigger only clicks until a magazine is seated.
              haptics.pulse(source, 0.22, 22);
              heldGun.cooldown = 0.16;
            } else {
              const firing = firingFor(heldGun.kind);
              heldGun.ammo -= 1;

              // Sound and kick land together: the shot starts first, so the bang
              // is already on its way when the motor answers.
              shot.play(heldGun.kind);
              haptics.fire(source, heldGun.kind);
              heldGun.recoil = firing.recoil;
              heldGun.cooldown = firing.cycle;
              heldGun.flash.fire();

              // Down the lane: the round leaves the muzzle and whatever it meets
              // takes the hit. The shotgun's pellets spread, the pistol's is one.
              heldGun.root.updateMatrixWorld(true);
              const origin = heldGun.root.localToWorld(heldGun.muzzle.position.clone());
              const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(heldGun.root.quaternion);
              const spread = heldGun.kind === "shotgun" ? 0.08 : 0;

              if (targets) targets.shoot(origin, direction, spread);

              /*
                Characters take the round the same way the range targets do, and
                the hit has a sound of its own — the body taking it, then the
                floor — so a shot that lands is heard as well as felt.
              */
              if (npcCrowd.shoot(origin, direction, spread)) {
                hitSound.play(heldGun.kind);
                haptics.pulse(source, 0.95, 80);
              }
            }
          }
        }

        // Spawned props: squeeze grabs the nearest mirror within reach.
        if (controller && source) {
          const grabbed = propGrabber.tryGrab(
            side,
            pose.position,
            pose.quaternion,
            squeeze,
            previousGrip[side],
            Boolean(heldGun) || weaponAction.holding(side, guns) || Boolean(heldNpc)
          );
          if (grabbed) haptics.pulse(source, 0.65, 45);
          if (propGrabber.release(side, squeeze, previousGrip[side])) haptics.pulse(source, 0.3, 25);
        }

        // The fingers close around whatever this hand carries: a gun's grip, or
        // the magazine it is carrying to the other hand.
        hand.update({
          trigger,
          grip: squeeze,
          dt,
          holding: Boolean(heldGun) || heldTool || Boolean(heldNpc),
          carrying: hipMagazines.holding(side) || weaponAction.holding(side, guns),
        });

        previousGrip[side] = squeeze;
        previousTrigger[side] = trigger;
      }

      // The chapter's own mission, on the head pose and hands of this frame.
      if (storyLayer) {
        storyLayer.update(dt, {
          head: headPosition,
          forward: headDirection,
          poses: controllerPose,
          triggers: triggerValues,
        });
      }

      // The hand-worked actions, advanced before the guns are placed this frame.
      weaponAction.update(dt, { guns, poses: controllerPose, presenting });

      for (const entry of guns) {
        if (entry.heldBy) {
          const pose = controllerPose[entry.heldBy];
          if (pose.connected) {
            // Attach through the grip point: the grip sits inside the palm,
            // offset from the controller's own axis.
            const attachment = entry.grip[entry.heldBy];
            entry.gripTarget.quaternion.copy(pose.quaternion).multiply(attachment.quaternion);
            entry.gripTarget.position
              .copy(attachment.position)
              .applyQuaternion(pose.quaternion)
              .add(pose.position);

            // A short pull into the hand on grab, then exact tracking — no lag
            // and no jitter once it is seated.
            entry.grabBlend = Math.min(1, entry.grabBlend + dt / 0.12);
            const blend = entry.grabBlend * entry.grabBlend * (3 - 2 * entry.grabBlend);

            entry.root.position.lerpVectors(entry.grabFrom.position, entry.gripTarget.position, blend);
            entry.root.quaternion.slerpQuaternions(entry.grabFrom.quaternion, entry.gripTarget.quaternion, blend);

            if (entry.recoil > 0) {
              entry.root.translateZ(entry.recoil * 0.05);
              entry.root.rotateX(entry.recoil * 0.22);
            }

            /*
              The action is worked on the moving part alone — see below. The gun
              body itself is never offset here, so it stays welded to the hand.
            */
          } else {
            entry.heldBy = null;
            entry.body.drop(new THREE.Vector3(), new THREE.Vector3());
          }
        } else {
          entry.body.step(dt);
        }

        entry.recoil = Math.max(0, entry.recoil - dt / 0.16);
        entry.cooldown = Math.max(0, entry.cooldown - dt);
        entry.cycle = Math.max(0, entry.cycle - dt / (entry.kind === "shotgun" ? 0.4 : 0.2));

        /*
          The action itself, and nothing else: the slide on the pistol, the pump
          on the shotgun, travelling back inside a body that stays exactly where
          the hand put it. Whichever is further along — the automatic cycle after
          a reload, or a hand working it — drives that one part.
        */
        const auto = entry.cycle > 0 ? Math.sin((1 - entry.cycle) * Math.PI) : 0;
        const stroke = Math.max(auto, weaponAction.strokeFor(entry));
        if (entry.slide) entry.slide.position.z = stroke * entry.slideTravel;

        /*
          Read straight off the gun's own state rather than a timer: a magazine
          on its way in, or an action that is not yet fully home, keeps it out of
          action — and only once both are done does it fire again. Each gun keeps
          its own flag, so one reloading never holds up the other.
        */
        entry.reloading = Boolean(entry.seating) || stroke > 0.001;

        entry.flash.update(dt);
      }

      // A magazine carried to the matching gun's magwell seats itself there.
      hipMagazines.update(dt, {
        controllers,
        guns,
        presenting,
        head: headLocal,
        forward: headDirection,
      });

      const heldNow = guns
        .filter((entry) => entry.heldBy)
        .map((entry) => ({
          side: entry.heldBy,
          id: entry.id,
          kind: entry.kind,
          ammo: entry.ammo,
          capacity: entry.capacity,
        }))
        .sort((a, b) => (a.side === b.side ? 0 : a.side === "left" ? -1 : 1));
      // Fed every frame, so the rounds on the chip always match the gun's own
      // count — the readout only repaints while it is actually moving.
      weaponHud.update(dt, heldNow);

      if (targets) targets.update(dt);

      propGrabber.update(dt, controllerPose);
      gloveMenu.update(dt);
      spawnerTool.update(dt, controllerPose);

      // The world's own animation, if it has any: the lobby photographs its maps.
      if (environment.update) environment.update(dt);
      if (lobbyReturn) lobbyReturn.update(dt, headPosition);
      spawnerPanel.setOpen(Boolean(spawnerTool.heldBy) || panelPinned);

      /*
        The crowd: each NPC walks, turns and animates on its own, kept apart from
        the others and out of the furniture. The hands are passed in so a hand
        brought close to one makes it look up and nod.
      */
      const handPoints = [];
      for (const side of ["left", "right"]) {
        if (controllerPose[side].connected) handPoints.push(controllerPose[side].position);
      }

      // The barrels the player has up, so the crowd knows when it is aimed at.
      const heldBarrels = [];
      for (const entry of guns) {
        if (!entry.heldBy) continue;
        entry.root.updateMatrixWorld(true);
        heldBarrels.push({
          origin: entry.root.localToWorld(entry.muzzle.position.clone()),
          direction: new THREE.Vector3(0, 0, -1).applyQuaternion(entry.root.quaternion),
        });
      }

      npcCrowd.update(dt, {
        head: headPosition,
        hands: handPoints,
        guns: heldBarrels,
        bounds,
        obstacles: solid,
        poses: controllerPose,
      });

      if (loadingHold > 0) {
        loadingHold -= dt;
        if (loadingHold <= 0) engine.loadingCard.hide();
      }

      /*
        The body stands exactly under the headset, in the rig's own frame.

        The head pose is already in that frame, so there is no world-space
        conversion left to get wrong: the body is fed the runtime's own offset
        every frame, which is why it can no longer slide, bounce or drift away
        from the player — walking, turning and physically stepping all move it
        with the head, and the floor stays at the rig's y = 0.
      */
      headForward.set(0, 0, -1).applyQuaternion(headLocalQuaternion);
      const bodyYaw = Math.atan2(headForward.x, headForward.z);

      avatar.update({ head: headLocal, yaw: bodyYaw, dt });

      beginMirrorFrame();
      renderer.render(scene, camera);

      /*
        The world is on screen: the startup card has done its job and steps out
        of the way. A frame that never arrives leaves it up, which is the whole
        point of it.
      */
      if (!firstFrame) {
        /*
          The world has been drawn: the card steps aside.

          It used to wait for a view pose as well, and that is what made a
          working lobby look like a loading screen that never finished — the
          session was presenting without poses, so the card held the screen
          forever. A session with no view is the session manager's problem, and
          it is already on it; the loading screen's job ends when the world is
          built and drawn.
        */
        if (renderer.info.render.triangles > 0) {
          firstFrame = true;
          engine.boot.done();
          startup.step("ready", `${spec.name} on screen`, 1, presenting ? "in headset" : "flat");
        }
      }

      // Live numbers, once a second, so a world that draws nothing says so.
      if (engine.boot.visible()) {
        const second = Math.floor(clock.elapsedTime);
        if (second !== lastStatus) {
          lastStatus = second;
          // The numbers that separate the failure modes: frames are running, the
          // session is on, and whether the headset is handing it any views.
          const views = presenting ? renderer.xr.getCamera().cameras.length : 0;
          const line =
            `frames ${frameCount} · xr ${presenting ? "on" : "off"} · views ${views} · ` +
            `tris ${renderer.info.render.triangles}`;
          engine.boot.status(line);
          startup.detail(line);
        }
      }

      frameCount += 1;
    };

    /*
      One bad frame must never become a black screen.

      Every subsystem of the world — the lobby's photographs, a character, a hand,
      a sound — is stepped from this loop, and an exception in any of them used to
      escape the frame: the world was never drawn again and the headset was left
      with whatever the compositor cleared to. Now the failure is reported on the
      card, in front of the eyes, and the world is still drawn underneath it.
    */
    let frameFailure = "";

    const animate = () => {
      try {
        frame();
      } catch (error) {
        const message = (error && (error.message || error.name)) || String(error);
        if (message !== frameFailure) {
          frameFailure = message;
          console.log(`[pickle-vr] frame failed: ${message}`);
          engine.boot.fail(error);
        }
        try {
          renderer.render(scene, camera);
        } catch (ignored) {
          /* nothing left to draw with */
        }
      }
    };

    renderer.setAnimationLoop(animate);
    // three drops its own XR loop when a session ends; this puts the world's back.
    engine.restartLoop = () => renderer.setAnimationLoop(animate);

    // In the flat preview the mouse picks menu rows with the same ray.
    const picker = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const onPointerDown = (event) => {
      /*
        On a headset browser a tap anywhere in the scene starts the session, so
        the game is one touch from an icon — no dedicated button to find. On a
        device without WebXR the click belongs to the menus, as before.
      */
      if (navigator.xr && !renderer.xr.isPresenting && enterRef.current) {
        enterRef.current();
        return;
      }

      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      picker.setFromCamera(pointer, camera);

      // The lobby's tiles, and the way back to it, take the click first.
      if (lobbyMode && environment.pick(picker.ray.origin, picker.ray.direction)) return;
      if (lobbyReturn && lobbyReturn.pick(picker.ray.origin, picker.ray.direction)) return;

      // Story messages and mission props take the click before the menus do.
      if (storyLayer && storyLayer.pick(picker.ray.origin, picker.ray.direction)) return;

      if (!gloveMenu.isOpen() && !spawnerPanel.isOpen()) return;
      if (spawnerPanel.isOpen()) spawnerPanel.pick(picker.ray.origin, picker.ray.direction);
      else gloveMenu.pick(picker.ray.origin, picker.ray.direction);
    };

    canvas.addEventListener("pointerdown", onPointerDown);

    // The engine owns the session; it only needs this world's sounds unlocked.
    engine.unlockAudio = () => {
      shot.unlock();
      actionSound.unlock();
      hitSound.unlock();
    };

    // Already inside a session (a map was just chosen): the world's sounds are
    // unlocked with the gesture that chose it.
    if (renderer.xr.isPresenting) engine.unlockAudio();

    // The world is up: name it on the loading card, then lift the blackout.
    engine.boot.stage(`World built: ${spec.name}`);
    engine.loadingCard.show(spec.name);
    engine.fade.fadeTo(0, 0.6);
    startup.step("assets", `${spec.name} assets ready`, 0.9, "");

    return () => {
      disposed = true;
      menuRef.current = null;
      canvas.removeEventListener("pointerdown", onPointerDown);
      renderer.setAnimationLoop(null);
      hands.left.dispose();
      hands.right.dispose();
      environment.dispose();
      if (pedestal) pedestal.dispose();
      if (rack) rack.dispose();
      mirrors.forEach((mirror) => mirror.dispose());
      propGrabber.dispose();
      hipMagazines.dispose();
      avatar.dispose();
      shot.dispose();
      actionSound.dispose();
      hitSound.dispose();
      guns.forEach((entry) => {
        entry.flash.dispose();
        entry.dispose();
      });
      if (storyLayer) storyLayer.dispose();
      if (lobbyReturn) lobbyReturn.dispose();
      if (lobbyPointer) lobbyPointer.dispose();
      gloveMenu.dispose();
      spawnerPanel.dispose();
      spawnerTool.dispose();
      npcCrowd.dispose();
      camera.remove(weaponHud.root);
      weaponHud.dispose();

      // Everything in the scene belongs to this world. The renderer, the camera
      // and the headset session stay with the page for the next map.
      scene.clear();
    };
  }, [map, story]);

  /*
    Leaving blacks the view out first, so the swap reads as one continuous move
    rather than a jump back to the menu.
  */
  const leave = () => {
    const engine = engineRef.current;
    if (engine) {
      engine.fade.fadeTo(1, 0.3);
      engine.loadingCard.show(story ? "Story menu" : "Main menu");
    }
    if (onExitToMenu) onExitToMenu();
  };

  return (
    <div className="absolute inset-0">
      <canvas ref={canvasRef} className="block h-full w-full" />

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-4 pb-9 sm:pb-11">
        {onMovementChange && <MovementSettings value={movement} onChange={onMovementChange} />}

        <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2">
          {!story && map !== "lobby" && (
            <>
              <button
                type="button"
                onClick={() => menuRef.current && menuRef.current.toggle()}
            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.05] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.24em] text-white/70 backdrop-blur-md transition duration-300 hover:border-white/30 hover:text-white active:scale-[0.98]"
          >
            <span className="h-1 w-1 rounded-full bg-white/50" />
            Gloves
          </button>

          <button
            type="button"
            onClick={() => menuRef.current && menuRef.current.npcs()}
            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.05] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.24em] text-white/70 backdrop-blur-md transition duration-300 hover:border-white/30 hover:text-white active:scale-[0.98]"
          >
            <span className="h-1 w-1 rounded-full bg-white/50" />
            NPC tool
          </button>

          <button
            type="button"
            onClick={() => spawnRef.current && spawnRef.current()}
            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.05] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.24em] text-white/70 backdrop-blur-md transition duration-300 hover:border-white/30 hover:text-white active:scale-[0.98]"
          >
            <span className="h-1 w-1 rounded-full bg-white/50" />
            Spawn mirror
              </button>
            </>
          )}

          {onExitToMenu && (
            <button
              type="button"
              onClick={leave}
              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.05] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.24em] text-white/70 backdrop-blur-md transition duration-300 hover:border-white/30 hover:text-white active:scale-[0.98]"
            >
              {story ? "Story" : "Menu"}
            </button>
          )}
        </div>

        {status === "ready" && (
          <button
            type="button"
            onClick={() => enterRef.current && enterRef.current()}
            className="pointer-events-auto inline-flex items-center gap-3 rounded-full border border-white/15 bg-white/[0.06] px-8 py-3.5 font-mono text-[11px] uppercase tracking-[0.3em] text-white/90 backdrop-blur-md transition duration-300 hover:border-white/35 hover:bg-white/[0.12] hover:text-white active:scale-[0.98]"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/90 shadow-[0_0_10px_rgba(52,211,153,0.9)]" />
            Start session
          </button>
        )}

        {status === "in-vr" && (
          <div className="inline-flex items-center gap-3 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-7 py-3 font-mono text-[11px] uppercase tracking-[0.3em] text-emerald-200/90">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            In headset
          </div>
        )}

        <p className="max-w-[22rem] px-6 text-center font-mono text-[10px] uppercase leading-relaxed tracking-[0.2em] text-white/35">
          {message}
        </p>
      </div>
    </div>
  );
}