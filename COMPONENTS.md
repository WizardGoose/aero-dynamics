# Component Map — Wizard's mod pack (mc 1.21.1, NeoForge)

Every component name below was extracted from the **exact jar files in the pack** (downloaded
from Modrinth by version, not guessed): `assets/<ns>/blockstates/*.json` are the block
registry ids, and `lang/en_us.json` gives the display names. Mods that only change behaviour
(marked "behaviour") add no blocks of their own.

## The building ecosystem (deep map)

### Create 6.0.10 (`create:`)
~450 blocks. The ones that matter for airships, ships and machines:

| role | components |
|---|---|
| **Power (kinetic)** | `shaft`, `cogwheel`, `large_cogwheel`, `gearbox`, `vertical_gearbox`, `gearshift`, `clutch`, `encased_chain_drive`, `adjustable_chain_gearshift`, `sequenced_gearshift`, `rotation_speed_controller`, `flywheel`, `stressometer`, `speedometer` |
| **Power sources** | `water_wheel`, `large_water_wheel`, `steam_engine`, `creative_motor`, `hand_crank`, `windmill_bearing` |
| **Bearings (contraptions)** | `mechanical_bearing`, `clockwork_bearing`, `turntable`, `gantry_carriage`, `gantry_shaft`, `rope_pulley`, `hose_pulley`, `elevator_pulley`, `mechanical_piston`, `sticky_mechanical_piston`, `mechanical_drill`, `mechanical_saw`, `mechanical_harvester`, `mechanical_plough`, `mechanical_roller`, `mechanical_arm`, `mechanical_press`, `mechanical_mixer`, `mechanical_crafter`, `mechanical_pump`, `deployer`, `millstone`, `crushing_wheel` |
| **Fluids** | `fluid_tank`, `creative_fluid_tank`, `fluid_pipe`, `smart_fluid_pipe`, `glass_fluid_pipe`, `encased_fluid_pipe`, `fluid_valve`, `hose_pulley`, `spout`, `item_drain`, `nozzle`, `portable_fluid_interface` |
| **Heat** | `blaze_burner`, `lit_blaze_burner`, `steam_whistle`, `steam_whistle_extension`, `copper_backtank`, `netherite_backtank` |
| **Chassis** | `radial_chassis`, `linear_chassis`, `secondary_linear_chassis` |
| **Casings** | `andesite_casing`, `brass_casing`, `copper_casing`, `railway_casing`, `refined_radiance_casing`, `shadow_steel_casing`, encased shafts/cogwheels in all of them, `industrial_iron_block` |
| **Sail/air** | `sail_frame`, 16× `*_sail` (colored sails for windmill/airship propulsion) |
| **Redstone/logic** | `redstone_link`, `redstone_contact`, `redstone_requester`, `pulse_repeater`, `pulse_extender`, `pulse_timer`, `powered_latch`, `powered_toggle_latch`, `analog_lever`, `display_link`, `display_board`, `nixie_tube`, `factory_gauge`, `content_observer`, `stockpile_switch`, `smart_chute`, `weighted_ejector`, `packager`, `package_frogport`, `lectern_controller`, `controls`, `contraption_controls`, `clipboard` |
| **Doors/seats** | `train_door`, `train_trapdoor`, 16× `*_seat`, 16× `*_toolbox`, `desk_bell`, `placard` |
| **Rails** | `track`, `track_signal`, `track_station`, `track_observer`, `controller_rail`, `controls`, bogeys (`small_bogey`, `large_bogey`) |

### Create Aeronautics 1.3.0 (bundled jar → `aeronautics:`, `simulated:`, `offroad:`)
| namespace | components |
|---|---|
| `aeronautics:` | `adjustable_burner`, `wooden_propeller`, `andesite_propeller`, `smart_propeller`, `propeller_bearing`, `gyroscopic_propeller_bearing`, 16× `*_envelope` + `*_envelope_encased_shaft` (airship hulls), `levitite`, `pearlescent_levitite`, `levitite_blend`, `steam_vent`, `mounted_potato_cannon` |
| `simulated:` | `physics_assembler` (core!), `steering_wheel`, `throttle_lever`, `directional_gearshift`, `analog_transmission`, `spring`, `torsion_spring`, `docking_connector`, `paired_docking_connector`, `rope_connector`, `rope_winch`, `altitude_sensor`, `velocity_sensor`, `gimbal_sensor`, `optical_sensor`, `laser_sensor` + `laser_pointer`, `modulating_linked_receiver`, `directional_linked_receiver`, `linked_typewriter`, `navigation_table`, `redstone_accumulator`, `redstone_inductor`, `redstone_magnet`, 16× `*_portable_engine`, 16× `*_symmetric_sail`, 16× `*_handle`, 16× `*_nameplate`, `auger_cog`, `auger_shaft`, `merging_glue` |
| `offroad:` | `wheel_mount`, `borehead_bearing`, `rockcutting_wheel` |

### Create Deep Seas 2.2.4 (`create_submarine:`, `create_abyss:`)
Submarine systems: `ballast_tank`, `ballast_vent`, `copper_pressurizer`, `iron_pressurizer`,
`electrolyzer`, `oxygene_diffuser`, `decompression_chamber`, `creative_oxygenator`,
`submarine_propeller`, `water_thruster`, `barometer`, `industrial_alarm`, `arresting_hook`,
`pulley`, `rockcutting_wheel`, `underwater_mine`, `submarine_liana`, `creepvine_seed`.
(Alpha/Early Access — pressure + oxygen mechanics.)

### Create Propulsion: Simulated 1.1.5 (`createpropulsionsimulated:`)
`thruster` (fuel, 600 pN), `ion_thruster` (FE, 1000 pN), `creative_thruster` (10 000 pN),
`copycat_wing`, `copycat_wing_8`, `copycat_wing_12`, `tilt_adapter`, items `pine_resin`,
`turpentine_bucket`. Force-at-point physics — placement matters.

### Create Aeronautics: Transmission & Linkage 0.2.5 (`aeronauticstransmissionlinkage:`)
`universal_joint`, `brass_universal_joint`, `hydraulic_hinge_head`, `hydraulic_hinge_link`,
`hydraulic_connection_head`, `hydraulic_regulator`, `damping_stress_bearing`.

### Create Big Cannons 5.11.7 (`createbigcannons:`)
~120 blocks: cannon barrels/chambers/ends in 4 metals (cast iron, bronze, steel, nethersteel),
breeches (sliding, quickfiring, screw), autocannons, ammunition (`solid_shot`, `ap_shot`,
`he_shell`, `shrapnel_shell`, `fluid_shell`, `smoke_shell`, `drop_mortar_shell`, `bag_of_grapeshot`,
`powder_charge`, `big_cartridge`, `mortar_stone`), mounts (`cannon_mount`,
`cannon_mount_extension`, `fixed_cannon_mount`, `cannon_carriage`, `yaw_controller`),
casting system (`cannon_cast`, `cannon_builder`, moulds, `casting_sand`, molten metals).

### Create Deco 2.1.3 (`createdeco:`)
In 7 metals (iron, industrial iron, andesite, brass, copper, zinc + netherite coinstack):
`*_hull`, `*_sheet_metal`, `*_catwalk`, `*_catwalk_railing`, `*_catwalk_stairs`, `*_support`,
`*_support_wedge`, `*_bars`, `*_mesh_fence`, `*_ladder`, `*_door`, `*_trapdoor`, `*_window`,
`*_window_pane`, `*_coinstack`, 16× `*_placard`, 16× `*_shipping_container`, colored lamps,
bricks (8 palettes × many forms), 19 decals (`decal_warning`, `decal_radioactive`, …).

### VS Hose Connectors 0.1.8 (`vsfluidlink:`)
`hose_connector`, `magnet_hose_connector`, `chain_connector`, `magnet_chain_connector`,
`electric_wire_connector`, `electric_magnet_wire_connector`, plus decorative/block forms.

### Behaviour mods (no new blocks)
- **Lever drugster** — Create/Design n' Decor/Supplementaries stepped levers work like
  Aeronautics throttle levers (cockpit controls).
- **Climbable Ropes for Create Aeronautics** — empty-hand climb mode for Aeronautics ropes.

## Ponder (Create's in-game manual) — what it is, for our site

Studied from Create 6 source (`foundation/ponder/`). Ponder is Create's interactive
documentation: each "scene" is a **keyframed storyboard over a real block scene**:

- a time axis with steps; the player scrubs back and forth
- blocks get **selected/highlighted** with outlines; blocks and entities animate
  (`AnimateBlockEntityInstruction.bearing/pulley/bogey/deployer`, keyframes, movement)
- **text windows** appear per step, plus an end-of-scene summary card
- the world is a clean grey void on a base plate — nothing but the machine

Create 6 moved the core into a standalone library (`net.createmod.ponder.api`), but the
vocabulary is unchanged. For our site, "more realistic to Create" means:

1. guides that look like Ponder (dark void, base plate, step scrubber, text windows)
2. generated machines ship with a **build sequence** — each step highlights the blocks to
   place, in order, exactly like a ponder scene
3. schematics made of **real Create blocks with valid blockstates** (axis, facing, lit, …)

## Studio roadmap / status

1. **Ponder-style guide engine** — ✅ DONE: step player with per-step text, cumulative
   highlight, oblique stacked-block view, scrubbing and auto-play.
2. **Steam engine machine** — ❌ REMOVED: the machines tab was cleared in the re-invention;
   machine guidance now lives in this reference + the handbook.
3. **Ship generator** — ♻ REPLACED: the old flyable-airship module was cleared; shape
   building is now led by the **rhombus crystal shard** (double-terminated, bullet-angled,
   hollow crystal hull with seeded imperfections; the studio sizes the cavity's burners
   and lift, the interior is yours to fit).
4. **Requirement math** — ♻ FOLDED: the standalone math tab was cleared; the lift/burner
   math now runs inside the Balloon, Propeller and Crystal tabs (1.5 lift per heated
   block, 1 burner per 500 blocks).
5. **Shapes primitives** — ✅ DONE: sphere, ellipsoid, cylinder, cone, pyramid, torus,
   dome — hollow or solid, in wool/planks/logs/glass.
6. **Schematic lab** — ✅ DONE: client-side Sponge v2 / structure NBT reader (modern +
   legacy layouts, gzip), block census, namespace breakdown, mass estimate, Create
   Aeronautics part census.
7. **Ideas** — control surfaces, tail assemblies, cannon decks (Big Cannons blocks are
   mapped above), Deep Seas submarine generator.
