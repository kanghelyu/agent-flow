# Advanced file navigation

AgentFlow Studio's left document rail now uses the smooth camera-navigation behavior
ported from `kanghelyu/dsh-deepseek-flow`.

- Step document click: 720 ms focus animation
- `WORKFLOW.md` click: 680 ms fit-view animation
- Fit toolbar button: 560 ms animation
- Easing: quartic ease-out (`1 - (1 - t)^4`)
- Re-targetable while an animation is running
- User pan / wheel zoom / node drag / edge connection cancels animation immediately
- `prefers-reduced-motion` is respected
- File rows include subtle hover / active motion to visually match the camera transition

The implementation lives directly in `studio/index.html`; no additional runtime
dependency is required.
