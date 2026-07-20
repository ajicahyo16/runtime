# Phase 4: Lifecycle Execution Visualizer

This phase describes the interactive execution flow visualizer, which illustrates the request-response lifecycle of Lacify Runtime v1.

## 1. The Conveyor-Belt Execution Flow
Instead of showing text logs, requests are visualized as glowing cargo packets moving along a track with 7 major processing check-points:

```
[Request In] ──► ( Wake ) ──► ( Validate ) ──► ( Execute ) ──► ( Persist ) ──► ( Update Summary ) ──► ( Respond ) ──► ( Sleep )
```

---

## 2. Interactive Steps & Animations

| Stage | Visual Representation | CSS/JS Trigger Effect |
| :--- | :--- | :--- |
| **Wake** | The "Actor" icon opens, changing from dark/grey to bright glowing Cyan. | Ring expand animation (`scale(1) -> scale(1.1)`). |
| **Validate** | A laser scanning bar sweeps across the request packet. | Linear gradient transition moving top-to-bottom. |
| **Execute** | Floating gears or energy lines connect to compute the logic. | Rotation transition on icon. |
| **Persist** | A data packet drops down into a cylinder icon (SQLite). | Fast slide down with a green splash ring. |
| **Update Summary** | Graphs and summary metrics flash and increment counters. | Number roll-up effect on the UI metrics. |
| **Respond** | The packet is fired towards the client/user side. | Horizontal slide out with a fading trail. |
| **Sleep** | The Actor icon closes and dims down to steel grey. | Slow transition opacity back to 0.4. |

---

## 3. Playback Controls & Speed
- **Live Stream Mode**: The visualizer listens to Worker events via SSE (Server-Sent Events) or WebSockets (developer-only diagnostic stream) and runs the animations in real-time.
- **Playback Speed Controller**: Allows developers to slow down the animation (e.g. 0.5x speed) or pause at any step to inspect the data payload details in a drawer.
