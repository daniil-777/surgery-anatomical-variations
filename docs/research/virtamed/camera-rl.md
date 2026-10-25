# RGB-D camera planning in the laparoscopic simulator

Research and implementation design, 25 October 2026.

## Purpose and scope

The camera lab is a simulation tool for surgeons, educators and robotics researchers to investigate camera-view objectives, train a local policy, inspect its behavior and export the experiment. Its learning environment is the current rendered three-dimensional scene. It does not learn surgical expertise from the VirtaMed reference video, infer operative intent from real surgical images, or provide a controller for a physical laparoscope.

The chosen method is **Dyna Double Q-learning on a small, guarded camera graph**, with rewards derived from rendered RGB and depth observations and from the simulator's known anatomical map. It performs actual exploration, temporal-difference updates and model replay. Training maintains a pair of tabular action-value functions and exports their average for inference. Calling this method a deep visual policy or an end-to-end RGB-D neural network would misdescribe it.

The simulator can support teaching and research about camera planning. Simulator scores do not establish clinical utility, surgeon proficiency, reconstruction accuracy or safe behavior in a patient. A clinical claim would require a separately specified study with expert evaluation and appropriate hardware, perception and safety validation.

## Evidence behind the choice

Li et al. learn laparoscope motion from reconstructed scenes and limited surgeon demonstrations using RGB-D observations and adversarial imitation learning with PPO. Their implementation uses 160 × 128 inputs and small continuous camera increments. They test on reconstructed scenes excluded from training; their results include failures. The paper supports using depth and a simulator, while also showing the data and evaluation required before describing a policy as learning expert camera behavior. [ICRA 2022, 3D Perception based Imitation Learning under Limited Demonstration for Laparoscope Control](https://arxiv.org/pdf/2204.03195)

Papaioannou et al. combine visibility from ray tracing with a finite decision process and Q-learning for camera coverage. Their reward accounts for newly observed surface points, elapsed steps and collisions. This provides a direct precedent for visibility-driven graph learning. Their coverage setting is not surgical validation. [CDC, Integrated Ray-Tracing and Coverage Planning Control using Reinforcement Learning](https://arxiv.org/pdf/2304.09631)

Dyna combines experience-driven updates with additional transitions sampled from a model. Here, the compact graph and captured observations provide a model on which many updates can run without repeatedly rendering the full anatomy. Double Q-learning uses separate estimators for action selection and evaluation to reduce maximization bias. Combining these ideas is an engineering choice for this simulator, rather than a reproduction of either original experiment. [Sutton, Dyna](https://papers.nips.cc/paper_files/paper/1990/hash/d9fc5b73a8d78fad3d6dffe419384e70-Abstract.html), [van Hasselt, Double Q-learning](https://papers.neurips.cc/paper_files/paper/2010/hash/091d584fced301b442654dd8c23b3fc9-Abstract.html)

Shielding treats forbidden actions separately from the objective being optimized. This motivates rejecting graph edges and playback motion that fail geometry checks, instead of expecting a large collision penalty to prevent every collision. The strength of any guarantee remains limited by the checked model. [Alshiekh et al., Safe Reinforcement Learning via Shielding](https://arxiv.org/abs/1708.08611)

Yang et al. explicitly address remote-center-of-motion constraints and image misorientation in laparoscope control. The implication for this application is to constrain the virtual scope's movement and stabilize its horizon, rather than merely moving a free camera to attractive viewpoints. [RA-L 2022, Autonomous Laparoscope Control for Minimally Invasive Surgery With Intuition and RCM Constraints](https://doi.org/10.1109/LRA.2022.3186507)

Camera quality also depends on the task. A cognitive camera-control study uses surgical-step-specific quality models and expert feedback. This motivates explicit targets and inspectable objective weights; an anatomical survey objective is not a substitute for knowing the surgeon's current operative goal. [Wagner et al., A learning robot for cognitive camera control in minimally invasive surgery](https://link.springer.com/article/10.1007/s00464-021-08509-8)

LapGym supplies parameterized surgical tasks and systematic RL baselines. It supports reporting task configuration and varying difficulty, rather than treating a successful demonstration on one scene as generality. [Scheikl et al., JMLR 2023](https://www.jmlr.org/papers/v24/23-0207.html)

## Why a large browser PPO policy is not the first implementation

A convolutional PPO agent would require a neural-network runtime, many rendered transitions, optimization diagnostics and a substantial training distribution. Recreating the ILLC result would additionally require usable camera demonstrations and its imitation-learning procedure. Those resources are not supplied by a single authored scene or its reference video.

The graph method is appropriate for rapid local experiments because the scene is already known and the set of useful nearby viewpoints is bounded. It keeps training compute independent of full-resolution rendering after capture, has small transferable state, and exposes what the policy learned. Its restriction is equally important: the policy belongs to that sampled scene and graph. It does not map arbitrary new RGB-D images directly to actions.

A conventional shortest-path or greedy view-quality planner is a useful baseline on a known graph. RL is valuable here as an experiment in delayed coverage rewards and configurable preferences, not as proof that learning is necessary for every camera path.

## Virtual scope kinematics

Use one virtual trocar position \(o\), unit shaft direction \(f(\theta,\phi)\), and insertion length \(\ell\). For the **straight 0° optical model**:

\[
p=o+\ell f(\theta,\phi),\qquad \|f\|=1,\qquad
\text{camera forward}=f.
\]

Legal motion increments change tilt or insertion while preserving that relation. A stable up vector limits unnecessary horizon rotation. The virtual port and allowable insertion/tilt ranges are simulator settings, not a patient-specific port recommendation. A 30° scope needs a fixed optical-axis offset relative to the shaft; independent `lookAt` orientation is not that model.

Create nodes by sampling these coordinates near a clear entry pose. Connect legal neighboring nodes only after checking their movement. A pair of collision-free endpoints is insufficient: the path between them must also be checked. Interpolated playback must preserve the port relation and test its successive positions, rather than linearly moving the lens through an unchecked chord.

The existing `SceneNavigationGuard` uses a swept sphere against visible geometric surfaces, with a 2 mm default navigation clearance. This is a **lens/surface guard**. It does not reconstruct tissue volumes, model trocar forces, test a complete scope shaft or robot arm, or establish that an arbitrary starting point is outside every organ. Keep those limitations explicit. Only connected, checked motion from the accepted entry is admissible; do not teleport between disconnected graph components.

Two exported clearance fields have different meanings. `graph.nodes[i].clearanceMm` is the geometric distance from that sampled lens position to the nearest checked surface, queried up to 100 mm. A value of 100 is the no-nearer-hit bound, not necessarily an exact 100 mm distance. `CameraPlannerState.clearanceMm` is the configured 2 mm guard radius, not a measured minimum along the route. `blockedMoves` counts stopped playback moves. Neither the configured radius nor a zero blocked-move count should be presented as an empirical continuous-path clearance measurement.

## RGB-D observation and map privilege contract

Every sampled view must identify its pose, camera intrinsics, near/far planes, image dimensions and capture stage. Capture actual RGB pixels and depth from the current scene. Cached geometry heuristics alone are not an RGB-D observation pipeline.

The compact policy inputs are the graph node and task progress. Images supply measurements used to evaluate each view and reward transitions. Inference consults the captured graph and learned Q values; it does not run a trained segmentation or depth-estimation network.

| Data | Origin | Use and limitation |
| --- | --- | --- |
| RGB pixels | Offscreen rendering of current scene materials and lighting | Brightness, dark/saturated fractions, contrast and texture evidence. Record whether capture includes the final optics/postprocessing stage. |
| Linear depth | Renderer depth pass or a documented geometric depth sensor | Working distance, invalid pixels and near-surface occupancy. Simulator ground truth is not clinical depth estimation. |
| Anatomical identity or target mask | Known scene mesh IDs or a simulator ID pass | Visible target coverage, framing and anatomical survey progress. This is privileged map information, not image recognition. |
| Camera pose and virtual port | Simulator state | Node transitions and scope constraint. Real equipment would need calibrated tracking/kinematics. |
| Guarded transitions | Current visible geometry | Restricts local motion according to the implemented lens guard. Does not represent complete physical safety. |
| Inspection mask | Episode memory | Records which defined anatomical targets or sectors have met the inspection criterion. |

Useful RGB summaries are mean luminance, contrast, fraction below a dark threshold, fraction above a saturation/glare threshold, and bounded image-gradient energy. Useful depth summaries include valid fraction, depth percentiles, central working distance, and occupancy closer than the configured lens margin. Normalize and clamp every feature and reject NaN or infinite inputs. Glare is a visibility penalty, not a reason to remove all wet-tissue highlights.

For standard, nonreversed perspective depth \(d\in[0,1]\), near plane \(n\), and far plane \(F\), positive axial depth is:

\[
z=\frac{nF}{F-d(F-n)}.
\]

Packed depth must first be unpacked according to the installed Three.js implementation. Background pixels need a separate validity convention. If a geometric ray sensor is used instead, record whether it measures Euclidean ray range or axial camera depth; these differ away from the image center. A depth preview should display the recorded quantity and units.

The captured dataset should preserve a versioned schema, scene/geometry/material/visibility fingerprint, camera calibration, feature definitions, target definitions, graph nodes and edges, image summaries, training configuration and seed. The current source code defines the concrete schema and numeric defaults; exported receipts must include those actual values rather than silently relying on this design note.

## State, coverage and rewards

For a survey episode, let \(v\) denote the current camera node and \(b\) a bitmask of inspected targets. The basic state is \(s=(v,b)\), plus the task/target if multiple tasks share a policy. Define the next mask by a deterministic visibility criterion:

\[
b'=b\mathbin{\mathrm{OR}}\operatorname{inspect}(v'),\qquad
\Delta C=\frac{\operatorname{popcount}(b')-
\operatorname{popcount}(b)}{K},
\]

where \(K\) is the number of requested targets. Count only targets actually visible under the capture's occlusion/depth test, with sufficient framing/coverage according to the declared criterion. Do not award inspection merely because the optical axis points toward a hidden organ's centroid.

The coverage mask is necessary because a reward for a first observation depends on history. A pose-only table would assign incompatible values to visits before and after inspection. If rewards additionally depend on a previous action or motion direction, include that variable in the state, or describe the resulting approximation. A fixed maximum episode length is a compute bound; exact finite-horizon optimality would additionally require time remaining in the state.

The implementation in [cameraRL.ts](../../../apps/studio/src/cameraRL.ts) uses:

\[
r=w_n\Delta N+w_f\mathbf{1}_{\mathrm{complete}}-w_t-w_mL
 -w_\omega\Theta+w_v V(s')-w_g G(s'),
\]

where \(\Delta N\) counts newly inspected requested targets, \(V\) is bounded view quality, \(G\) is saturated-pixel glare fraction, \(L\) is movement in millimetres and \(\Theta\) is rotation in radians. Current reward version `viscera.camera-coverage-reward/1` has these presets:

| Preset | New target | Completion | Step cost | Distance cost/mm | Angle cost/rad | View quality | Glare penalty |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Coverage | 4 | 6 | 0.16 | 0.006 | 0.12 | 0.08 | 0.12 |
| Steady | 4 | 6 | 0.18 | 0.012 | 0.45 | 0.10 | 0.35 |

View quality combines the captured target-quality measure, valid-depth fraction, contrast, sharpness, near-surface fraction, glare and darkness; it is clamped to [0,1]. Even a perfect image cannot outweigh the per-step cost without new coverage, so cycling a photogenic view does not produce a positive step reward. Record the reward version and preset in the export. These weights encode the experimental preference; they are not learned clinical standards.

Completion should terminate the episode, and inspected targets must not repeatedly earn first-observation reward. This prevents a stationary high-quality view or repeated oscillation from accumulating an unlimited inspection bonus. Keep reward components observable during review.

For potential-based shaping with a discounted objective, the policy-preserving term is \(\gamma\Phi(s')-\Phi(s)\), not an arbitrary quality difference. If the implementation uses other view-quality terms, those terms are part of the chosen task objective; do not claim they preserve an unrelated objective's optimal policy. [Ng, Harada and Russell, ICML 1999](https://ai.stanford.edu/~ang/papers/shaping-icml99.pdf)

## Dyna Double Q training and inference

Maintain two tables \(Q_A,Q_B\). During an update to table A, select the next legal action with A and evaluate it with B:

\[
a^*=\arg\max_{a'\in A_{\mathrm{safe}}(s')}Q_A(s',a'),
\]
\[
Q_A(s,a)\leftarrow Q_A(s,a)+\alpha
\left[r+\gamma Q_B(s',a^*)-Q_A(s,a)\right].
\]

Swap A and B for the complementary updates. Terminal transitions have zero bootstrap value. If no legal successor action exists, end the rollout and report the disconnected/dead-end condition. Use the same legal-action mask for exploration, bootstrapping, deterministic evaluation and playback.

Explore with a seeded epsilon-greedy policy over combined table values. After an experienced graph transition, perform a bounded number of additional updates from recorded model transitions. The coverage mask belongs in the replay state and must be updated consistently; replaying a node transition must not reuse a reward computed for an incompatible inspection history.

The current implementation bounds a graph to 48 nodes and six targets, observations to 128 × 128, training to 10,000 episodes, and episodes to 256 steps. The default episode budget is 64 steps. It uses Float64 Q tables, \(\gamma=0.96\), eight Dyna updates per experienced transition, and a seeded epsilon schedule declining from 0.55 toward 0.06. Learning rate declines with the count for each table entry but has a floor of 0.08. These bounds prevent unbounded allocation or accidental browser jobs; they do not establish convergence. Node-count-squared storage reserves an entry for each possible destination, while action selection considers only existing legal edges.

The Dyna model is the captured static scene graph. Model replay increases update efficiency; it does not create new image evidence, model tissue changes, or demonstrate generalization to a different anatomy. Report experienced transitions and replay updates separately. Finite training is an empirical result, not a convergence guarantee. Classical tabular convergence results require conditions on exploration, learning rates and the decision process that are stronger than merely running a short browser session. [Watkins and Dayan, Q-learning](https://www.gatsby.ucl.ac.uk/~dayan/papers/cjch.pdf)

At inference, set exploration to zero and use deterministic tie-breaking. Bound rollout length and detect repeated states. Reject a policy or route containing nonfinite values, unknown node IDs, illegal edges or incompatible fingerprints. Validate actual playback motion independently of the learned score.

## Browser execution and rendering integrity

Keep learning and model replay in a dedicated Web Worker. Transfer compact typed-array buffers when ownership can move; do not repeatedly copy full-resolution images for each update. Send progress at a bounded rate and yield between bounded batches so cancellation can be processed. Worker failure must leave the scene usable and report an actionable error. [MDN, Using Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers), [transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)

Use low-resolution offscreen render targets for capture. Where supported by the installed Three.js version, asynchronous readback avoids an unnecessary synchronous GPU wait. A depth material or depth texture can provide the depth signal; its encoding and material/alpha behavior must be tested. [Three.js WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer), [MeshDepthMaterial](https://threejs.org/docs/pages/MeshDepthMaterial.html), [DepthTexture](https://threejs.org/docs/pages/DepthTexture.html)

Restore all renderer and scene state in `finally`: render target, viewport, scissor/test, clear color/alpha, tone mapping/output settings, override material, camera state and temporary visibility changes. Update camera-attached lighting for the sampled pose and restore its visible-scene state afterward. A failed or cancelled observation pass must not leave the main canvas showing a depth pass or changed camera.

Freeze relevant geometry during sampling and playback, or immediately cancel/invalidate when it changes. A disease edit, anatomy-word edit, reset, material/lighting change affecting observations, visibility change, scene reload or unaccounted deformation can make a captured graph stale. Manual camera input and explicit Stop must interrupt autonomous playback. New training requests must not race an older Worker result into the active scene.

## Reproducibility and evaluation gates

Every run must export the seed and evaluation-seed derivation, graph/scene fingerprint, observation configuration, reward version/preset, training budget, learned values or policy, evaluation summaries and planned poses/actions. If images are not exported, say so explicitly: feature summaries alone cannot reconstruct an RGB-D dataset.

The built-in evaluation disables exploration and reserves up to eight starting nodes, selected using a separate seeded shuffle, from the training episode-start schedule. The graph's primary start remains in training. Training trajectories can still pass through reserved starting nodes, and their observations are part of the captured graph. Therefore label these results **held-out starting viewpoints on the same captured graph**, not unseen visual observations. Learned and greedy inference are deterministic; the random baseline has a reproducible stream derived from the training seed and starting-node ID. A one-node graph has no distinct held-out start and reports empty evaluation summaries rather than relabeling a training start.

Different pseudorandom starts on one graph test starts, not new anatomies; a fresh lighting perturbation tests that perturbation, not real-image transfer. Testing disease-shape generality requires separately captured altered scenes and an explicit adaptation/generalization protocol.

The following are acceptance checks to run, not results established by this document:

1. **Learning integrity:** tables change through real TD updates; identical seed/configuration reproduces results; terminal states and legal masks are correct; replay respects coverage history; malformed/oversized inputs fail cleanly.
2. **Baselines:** evaluate the built-in seeded-random and greedy immediate-reward policies using the same start distribution and episode budget as the learned policy. Report return, inspection success and coverage even if the trained policy does not win. Stationary and known-graph shortest-path references can provide additional checks; they are not additional learned policies.
3. **Motion integrity:** no illegal graph edge; finite camera poses; virtual-port relation within numerical tolerance; all playback substeps checked; clear minimum-clearance and blocked-action reporting. Test endpoints whose connecting motion is blocked.
4. **Observation integrity:** RGB and depth actually change across views; depth units/encoding match known geometry; an occluded organ does not receive visible coverage; glare/darkness measures respond to lighting changes; renderer state is restored after errors/cancellation.
5. **Performance:** measure capture duration, Worker training duration, transition/update counts, memory, inference latency and visible-frame responsiveness on the tested device. A small table's speed is not a universal device guarantee.
6. **Interaction:** retrain, Stop, manual interruption, reset, scene changes, anatomy edits, hidden targets, empty/disconnected graphs, mobile layout, resize, WebGL loss and Worker failure leave consistent controls and state.
7. **Visual review:** inspect the actual rendered playback and RGB-D previews from several starts/angles, including obstructed and reflective views. A numerical reward alone does not assess whether the route is useful to a surgeon.

Do not enable playback for a route failing structural or motion checks. A weak learning score should remain visible as a weak score; it should not silently be replaced with a handcrafted route and still be presented as the learned policy. Record any fallback method by name.

## One measured browser run

The initial completed browser fixture, `RGBD camera policy trains, evaluates and replays without altering anatomy`, produced `camera-evidence.json` and an exported `camera-study.json` under `/tmp/viscera-camera-rl/browser/test-results/camera-rl-RGBD-camera-poli-a7f02-ys-without-altering-anatomy/`. The evidence SHA-256 is `a35c822ea70dda52c2841b82b13b3b88605b65826d1302c4ed8d00c3bb4d0a90`. This paragraph records that specific run; later receipts can have different timings and fingerprints.

The fixture used the local VirtaMed baseline scene, operative camera, Coverage reward, seed 42, 3,000 episodes and a 64-step limit. The Playwright configuration uses one worker and a 1,440 × 1,000 browser viewport; its macOS launch selects installed Chrome with ANGLE Metal. The receipt does not identify a full hardware/browser-version benchmark environment. It is an implementation check, not a cross-device performance study.

| Measurement | Observed value |
| --- | ---: |
| Captured views | 27 at 64 × 48 RGB + depth |
| Graph edges | 108 directed / 54 undirected |
| Rejected graph connections | 0 in this fixture |
| Graph construction | 15.7 ms |
| Complete map capture | 2,318.9 ms |
| First observation | 1,842.5 ms, including first-use rendering costs |
| Median observation after the first | 12.8 ms |
| Worker training | 11.2 ms |
| Initial route inference and its validation | 3.2 ms |
| Experienced transition updates | 4,887 |
| Dyna replay updates | 39,096 |
| Total TD updates | 43,983 |

The nominal survey requested five landmarks. **Only liver and gallbladder met the framing criterion anywhere in this local graph** (`goalMask=3`); cystic duct, extrahepatic bile duct and cystic artery were not credited as well framed. The percentages below therefore describe completion of the two reachable landmarks, not completion of a five-landmark hepatobiliary examination.

Five reserved starting nodes were `[3, 9, 12, 14, 19]`, with 22 other episode starts used for training. These are reserved **episode starts on the same graph**: training trajectories could still visit those nodes, and all rendered observations were captured before training. No unseen anatomy or real surgical imagery was evaluated.

| Policy | Successful starts | Mean reachable-target coverage | Mean steps | Mean travel | Mean undiscounted return |
| --- | ---: | ---: | ---: | ---: | ---: |
| Learned Double Q | 5/5 | 100% | 2.0 | 46.57 mm | 11.84 |
| Greedy immediate reward | 3/5 | 80% | 26.4 | 418.83 mm | 2.22 |
| Seeded random | 5/5 | 100% | 9.6 | 210.72 mm | 9.83 |

The selected replay from node 0 followed `[0, 13]`, one 25 mm insertion-axis move, and ended with both reachable landmarks credited. Playback completed with zero blocked moves. Capture preserved the live camera and camera-light snapshot; organ geometry/material signatures remained unchanged after capture and after replay. The recorded browser/shader error list was empty. Exported sampled-node surface distances ranged from 37.53 to 92.47 mm. Those endpoint measurements are distinct from the planner state's configured 2 mm guard and do not measure the minimum over every point on a continuous route.

This is one small local task and one seed. It shows functioning RGB-D capture, genuine value updates, baseline comparison, export and bounded playback. It does not establish consistent superiority over baselines, obstacle-avoidance performance in a difficult workspace, reliability across repeated runs, disease variants, user-defined viewpoints or surgeon-rated camera quality. In particular, this fixture rejected no graph edges and replayed a short axial movement; dedicated obstructed-edge, stale-map, cancellation and alternative-view tests remain separate evidence.

## Use in surgical education and research

The useful training interaction is to choose an inspection target, change view-quality/coverage/movement preferences, train, compare against baselines, review the camera path and export the full experiment. This lets a surgeon explain why a view is useful or distracting and lets a researcher investigate how that preference changes policy behavior.

Expert demonstration recording and preference labels would support later imitation or offline RL research, but they are separate capabilities and must not be implied by generated graph paths. Likewise, motion near a simulated organ is not evidence of safe tissue contact. Future physical translation would need calibrated camera/shaft geometry, trocar and robot constraints, robust perception, dynamic tissue handling and expert-defined operative objectives in addition to the present simulator policy.
