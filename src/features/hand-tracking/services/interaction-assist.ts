import { DIFFICULTY_PRESETS, PuzzleDifficulty } from "@/features/puzzle/constants/puzzle-difficulty";

import { InteractionConfig } from "@/features/hand-tracking/constants/interaction-config";

export interface InteractionAssistConfig {
  snapRadius: number; // ~40px
}

export interface HitTestEvaluation {
  px: number;
  py: number;
  candidates: {
    pieceId: string;
    inside: boolean;
    rect: DOMRect;
    logicalRect: DOMRect;
  }[];
  chosenId: string | null;
  browserTargetId: string | null;
}

export class InteractionAssistService {
  private config: InteractionAssistConfig = {
    snapRadius: 40,
  };

  private getBoardRect: () => DOMRect | null = () => null;
  private difficulty: PuzzleDifficulty = "easy";
  
  // Generic target registry
  private targets = new Map<string, HTMLElement>();
  
  // Grace period when pointer briefly slips out of all targets (prevents 500ms timer reset on micro-jitter)
  private lastHoveredTarget: { id: string; lastSeenTime: number } | null = null;
  private readonly DROPOUT_TOLERANCE_MS = 120;

  // Diagnostic state for Spatial Debug Overlay
  private lastHitTest: HitTestEvaluation | null = null;

  public getTargets(): Map<string, HTMLElement> {
    return this.targets;
  }

  public getBoardRectProp(): DOMRect | null {
    return this.getBoardRect();
  }

  public getLastHitTest(): HitTestEvaluation | null {
    return this.lastHitTest;
  }

  registerTarget(id: string, element: HTMLElement) {
    this.targets.set(id, element);
  }

  unregisterTarget(id: string) {
    this.targets.delete(id);
    if (this.lastHoveredTarget?.id === id) {
      this.lastHoveredTarget = null;
    }
  }

  updateContext(getBoardRect: () => DOMRect | null, difficulty: PuzzleDifficulty) {
    this.getBoardRect = getBoardRect;
    this.difficulty = difficulty;
    this.lastHoveredTarget = null;
  }

  // Smart Hit Tester using live deterministic bounding boxes
  hitTest(x: number, y: number): string | undefined {
    const px = x * window.innerWidth;
    const py = y * window.innerHeight;
    const now = performance.now();

    let candidateId: string | undefined = undefined;
    
    const evaluation: HitTestEvaluation = {
      px,
      py,
      candidates: [],
      chosenId: null,
      browserTargetId: null,
    };

    const scale = InteractionConfig.logicalHitboxScale;
    for (const [id, element] of this.targets.entries()) {
      const rect = element.getBoundingClientRect();
      const wInset = (rect.width * (1 - scale)) / 2;
      const hInset = (rect.height * (1 - scale)) / 2;
      const logicalRect = new DOMRect(
        rect.left + wInset,
        rect.top + hInset,
        rect.width * scale,
        rect.height * scale
      );
      
      const inside = (px >= logicalRect.left && px <= logicalRect.right && py >= logicalRect.top && py <= logicalRect.bottom);
      
      evaluation.candidates.push({ pieceId: id, inside, rect, logicalRect });
      
      if (inside) {
        candidateId = id;
        break;
      }
    }

    if (candidateId) {
      // Switch immediately to the piece under the pointer (never lag behind on a previously hovered piece)
      this.lastHoveredTarget = { id: candidateId, lastSeenTime: now };
      evaluation.chosenId = candidateId;
      this.lastHitTest = evaluation;
      return candidateId;
    }

    // Brief dropout tolerance only when cursor temporarily falls outside all targets
    if (
      this.lastHoveredTarget &&
      this.targets.has(this.lastHoveredTarget.id) &&
      now - this.lastHoveredTarget.lastSeenTime <= this.DROPOUT_TOLERANCE_MS
    ) {
      evaluation.chosenId = this.lastHoveredTarget.id;
      this.lastHitTest = evaluation;
      return this.lastHoveredTarget.id;
    }

    this.lastHoveredTarget = null;
    this.lastHitTest = evaluation;
    return undefined;
  }



  // Evaluates adaptive drop snap target
  getAdaptiveDropTarget(x: number, y: number): number | null {
    const boardRect = this.getBoardRect();
    if (!boardRect) return null;
    
    const px = x * boardRect.width;
    const py = y * boardRect.height;
    
    const { columns, rows } = DIFFICULTY_PRESETS[this.difficulty];
    const slotWidth = boardRect.width / columns;
    const slotHeight = boardRect.height / rows;
    
    let closestSlotIndex = null;
    let minDistance = Infinity;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        const slotCenterX = (col + 0.5) * slotWidth;
        const slotCenterY = (row + 0.5) * slotHeight;
        
        const dx = px - slotCenterX;
        const dy = py - slotCenterY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance < minDistance) {
          minDistance = distance;
          closestSlotIndex = row * columns + col;
        }
      }
    }
    
    // Snap automatically if within snap radius, otherwise return closest slot 
    // Wait, the prompt says "If inside the snap radius... snap automatically. Otherwise: return the piece to its original slot."
    if (minDistance <= this.config.snapRadius) {
      return closestSlotIndex;
    }
    return null;
  }

}

export const interactionAssist = new InteractionAssistService();
