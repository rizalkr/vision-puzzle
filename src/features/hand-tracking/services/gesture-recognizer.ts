import type { HandState } from "../types/hand-state";
import type { GestureState, HitTester, NormalizedPointerEvent } from "../types/gesture-state";
import { InteractionConfig } from "../constants/interaction-config";
import { trackingDiagnostics } from "./diagnostics-service";


type EventCallback = (event: NormalizedPointerEvent) => void;

export class GestureRecognizer {
  private state: GestureState = {
    hovering: false,
    pinching: false,
    phase: "idle",
  };

  private pinchStartTime = 0;
  private pinchEndTime = 0;
  private isPhysicallyPinching = false;
  private trackingLostTime = 0;
  private lastPointer = { x: 0, y: 0 };

  private onEvent?: EventCallback;
  private hitTester?: HitTester;

  setCallbacks(onEvent: EventCallback, hitTester: HitTester) {
    this.onEvent = onEvent;
    this.hitTester = hitTester;
  }

  getIsPinching(): boolean {
    return this.state.pinching;
  }

  process(handState: HandState, timestamp: number, aspectRatio = 16 / 9): GestureState {
    if (!handState.detected || handState.landmarks.length < 9) {
      if (this.state.pinching) {
        if (this.trackingLostTime === 0) {
          this.trackingLostTime = timestamp;
        } else if (timestamp - this.trackingLostTime > InteractionConfig.dragPersistenceMs) {
          trackingDiagnostics.recordAccidentalRelease();
          this.emit("pointerUp", this.lastPointer.x, this.lastPointer.y, this.state.hoveredPieceId);
          this.state = { hovering: false, pinching: false, phase: "idle" };
          this.isPhysicallyPinching = false;
        }
      } else {
        this.state = { hovering: false, pinching: false, phase: "idle" };
        this.isPhysicallyPinching = false;
        this.trackingLostTime = 0;
      }
      return this.state;
    }

    this.trackingLostTime = 0;
    const pointer = handState.pointer;
    this.lastPointer = pointer;
    
    const hoveredPieceId = this.hitTester?.hitTest(pointer.x, pointer.y);
    const hovering = !!hoveredPieceId;

    // Landmark 4: Thumb tip, Landmark 8: Index tip, Landmark 0: Wrist, Landmark 9: Middle MCP
    const thumb = handState.landmarks[4];
    const index = handState.landmarks[8];
    const wrist = handState.landmarks[0];
    const middleMcp = handState.landmarks[9];

    // Compensate X for video aspect ratio so distances are isotropic regardless of hand tilt
    const dx = (thumb.x - index.x) * aspectRatio;
    const dy = thumb.y - index.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    const palmSize =
      wrist && middleMcp
        ? Math.max(0.05, Math.hypot((middleMcp.x - wrist.x) * aspectRatio, middleMcp.y - wrist.y))
        : 0.2;
    const pinchRatio = distance / palmSize;
    
    let { phase, pinching } = this.state;

    // Pinch Hysteresis
    if (!this.isPhysicallyPinching && pinchRatio < InteractionConfig.pinchStartRatio) {
      this.pinchStartTime = timestamp;
      this.isPhysicallyPinching = true;
    } else if (this.isPhysicallyPinching && pinchRatio > InteractionConfig.pinchEndRatio) {
      this.pinchEndTime = timestamp;
      this.isPhysicallyPinching = false;
    }

    if (this.isPhysicallyPinching && !pinching) {
      const isDeepPinch = pinchRatio < InteractionConfig.pinchInstantRatio;
      if (isDeepPinch || timestamp - this.pinchStartTime >= InteractionConfig.pinchDebounceMs) {
        pinching = true;
        phase = "pinch-start";
        trackingDiagnostics.recordPinchStart();
        if (hoveredPieceId) {
          trackingDiagnostics.recordGrab(hoveredPieceId);
        }
        this.emit("pointerDown", pointer.x, pointer.y, hoveredPieceId);
      }
    } else if (!this.isPhysicallyPinching && pinching) {
      if (timestamp - this.pinchEndTime >= InteractionConfig.releaseConfirmationMs) {
        pinching = false;
        phase = "pinch-end";
        trackingDiagnostics.recordPinchEnd(this.state.hoveredPieceId);
        this.emit("pointerUp", pointer.x, pointer.y, hoveredPieceId);
      }
    } else if (pinching) {
      phase = "pinching";
      this.emit("pointerMove", pointer.x, pointer.y, hoveredPieceId);
    } else {
      phase = hovering ? "hover" : "idle";
      this.emit("pointerMove", pointer.x, pointer.y, hoveredPieceId);
    }



    this.state = {
      hovering,
      hoveredPieceId,
      pinching,
      phase,
    };

    return this.state;
  }

  private emit(
    type: "pointerMove" | "pointerDown" | "pointerUp",
    x: number,
    y: number,
    hoveredPieceId?: string
  ) {
    if (this.onEvent) {
      this.onEvent({ type, x, y, hoveredPieceId });
    }
  }
}
