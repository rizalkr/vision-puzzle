import React from "react";
import type { PuzzlePiece as PuzzlePieceType } from "../types/puzzle-piece";
import type { CapturedPhoto } from "@/types";
import { PuzzleDifficulty, DIFFICULTY_PRESETS } from "../constants/puzzle-difficulty";
import { PuzzlePiece } from "./puzzle-piece";
import { usePuzzleStore } from "@/store/puzzle-store";
import { motion } from "motion/react";
import { useUnifiedDrag } from "../hooks/use-unified-drag";
import { interactionAssist } from "@/features/hand-tracking/services/interaction-assist";
import { useGlobalPointer } from "@/features/hand-tracking/providers/global-pointer-provider";


interface PuzzleBoardProps {
  pieces: PuzzlePieceType[];
  sourceImage: CapturedPhoto | null;
  difficulty: PuzzleDifficulty;
}

export function PuzzleBoard({ pieces, sourceImage, difficulty }: PuzzleBoardProps) {
  const boardRef = React.useRef<HTMLDivElement>(null);
  const movePieceToSlot = usePuzzleStore((state) => state.movePieceToSlot);
  const isComplete = usePuzzleStore((state) => state.isComplete);
  const selectedPieceId = usePuzzleStore((state) => state.selectedPieceId);
  const handlePieceSelection = usePuzzleStore((state) => state.handlePieceSelection);
  const { registerSurface, unregisterSurface, pointerState, subscribePointer, getPointerState } = useGlobalPointer();
  const selectedPieceIdRef = React.useRef(selectedPieceId);
  
  React.useEffect(() => {
    selectedPieceIdRef.current = selectedPieceId;
  }, [selectedPieceId]);

  const [hoveredPieceId, setHoveredPieceId] = React.useState<string | null>(null);

  // Evaluate hovered piece via high-frequency pointer subscription and only commit when ID changes
  React.useEffect(() => {
    if (isComplete || pieces.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHoveredPieceId(null);
      return;
    }

    const evaluateHover = (state: { x: number; y: number; phase: string }) => {
      if (state.phase === "hidden") {
        setHoveredPieceId((prev) => (prev === null ? prev : null));
        return;
      }
      const nextHovered = interactionAssist.hitTest(state.x, state.y) ?? null;
      setHoveredPieceId((prev) => (prev === nextHovered ? prev : nextHovered));
    };

    evaluateHover(getPointerState());
    return subscribePointer(evaluateHover);
  }, [isComplete, pieces.length, subscribePointer, getPointerState]);

  const isAutoSelecting =
    pointerState.source === "hand" &&
    selectedPieceId === null &&
    hoveredPieceId !== null &&
    !isComplete;

  // 500ms Auto-Select Timer for Hand Tracking (no per-frame React state updates)
  React.useEffect(() => {
    if (!isAutoSelecting || !hoveredPieceId) return;

    const timer = window.setTimeout(() => {
      handlePieceSelection(hoveredPieceId);
    }, 500);

    return () => {
      window.clearTimeout(timer);
    };
  }, [isAutoSelecting, hoveredPieceId, handlePieceSelection]);

  const handleDrop = React.useCallback(
    (pieceId: string, clientX: number, clientY: number) => {
      if (!boardRef.current) return;
      const rect = boardRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      // Check adaptive drop target first
      const adaptiveTarget = interactionAssist.getAdaptiveDropTarget(clientX, clientY);
      if (adaptiveTarget !== null) {
        movePieceToSlot(pieceId, adaptiveTarget);
        return;
      }

      // Fallback
      if (x < 0 || x > rect.width || y < 0 || y > rect.height) {
        return;
      }

      const { columns, rows } = DIFFICULTY_PRESETS[difficulty];
      const col = Math.floor((x / rect.width) * columns);
      const row = Math.floor((y / rect.height) * rows);

      const safeCol = Math.max(0, Math.min(col, columns - 1));
      const safeRow = Math.max(0, Math.min(row, rows - 1));
      
      const targetSlotIndex = safeRow * columns + safeCol;
      movePieceToSlot(pieceId, targetSlotIndex);
    },
    [difficulty, movePieceToSlot]
  );

  const { dragState, handlePointerDown, forcePointerUp } = useUnifiedDrag({
    boardRef,
    onDrop: handleDrop,
  });

  // Register with GlobalPointerProvider and InteractionAssist
  React.useEffect(() => {
    interactionAssist.updateContext(() => boardRef.current?.getBoundingClientRect() ?? null, difficulty);
    
    if (boardRef.current) {
      registerSurface({
        id: "puzzle-board",
        element: boardRef.current,
        priority: 4, // Priority 4 as per spec (lower than overlays)
        magnetic: false,
        callbacks: {
           onPress: (x?: number, y?: number) => {
             const state = getPointerState();
             const currentSelectedId = selectedPieceIdRef.current;
             
             // Use exact pointer coordinates at the moment of pinch if provided (H1 Fix)
             const pointerX = x ?? state.x;
             const pointerY = y ?? state.y;
             
             const hitTestHoveredId = interactionAssist.hitTest(pointerX, pointerY);

             if (hitTestHoveredId) {
               if (state.source === "hand" && currentSelectedId === null) {
                 return; // Hand tracking uses auto-hover for initial selection
               }
               handlePieceSelection(hitTestHoveredId);
             }
           },
           onRelease: () => {
             forcePointerUp();
           }
        }
      });
    }

    return () => unregisterSurface("puzzle-board");
  }, [difficulty, pieces, registerSurface, unregisterSurface, handlePieceSelection, forcePointerUp, getPointerState]);

  if (!sourceImage) return null;

  let previewSlotIndex: number | null = null;
  if (dragState.isDragging && dragState.boardRect) {
    const adaptiveTarget = interactionAssist.getAdaptiveDropTarget(dragState.currentX, dragState.currentY);
    if (adaptiveTarget !== null) {
      previewSlotIndex = adaptiveTarget;
    } else {
      const rect = dragState.boardRect;
      const x = dragState.currentX - rect.left;
      const y = dragState.currentY - rect.top;
  
      if (x >= 0 && x <= rect.width && y >= 0 && y <= rect.height) {
        const { columns, rows } = DIFFICULTY_PRESETS[difficulty];
        const col = Math.floor((x / rect.width) * columns);
        const row = Math.floor((y / rect.height) * rows);
        const safeCol = Math.max(0, Math.min(col, columns - 1));
        const safeRow = Math.max(0, Math.min(row, rows - 1));
        previewSlotIndex = safeRow * columns + safeCol;
      }
    }
  }

  const { columns, rows } = DIFFICULTY_PRESETS[difficulty];
  const slotWidthPct = 100 / columns;
  const slotHeightPct = 100 / rows;

  return (
    <div className="relative w-full max-w-4xl aspect-[4/3] mx-auto flex items-center justify-center p-4 sm:p-8">
      {/* Pieces Container - Landscape aspect ratio */}
      <motion.div 
        ref={boardRef} 
        className="relative w-full h-full"
        animate={{
          scale: isComplete ? 1.02 : 1,
          filter: isComplete ? "drop-shadow(0 20px 30px rgba(255,255,255,0.2)) drop-shadow(0 0 40px rgba(255,255,255,0.1))" : "none",
        }}
        transition={{
          duration: 0.8,
          ease: "easeOut"
        }}
      >
        {previewSlotIndex !== null && !isComplete && (
          <motion.div
            className="absolute border-2 border-white/50 bg-white/10 rounded pointer-events-none"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ 
              opacity: 1, 
              scale: 1,
              left: `${(previewSlotIndex % columns) * slotWidthPct}%`,
              top: `${Math.floor(previewSlotIndex / columns) * slotHeightPct}%`,
              width: `${slotWidthPct}%`,
              height: `${slotHeightPct}%`,
            }}
            transition={{ duration: 0.15 }}
            style={{ zIndex: 0 }}
          />
        )}
        
        {pieces.map((piece) => (
          <PuzzlePiece 
            key={piece.id} 
            piece={piece} 
            sourceImage={sourceImage}
            difficulty={difficulty}
            dragState={dragState}
            isHovered={hoveredPieceId === piece.id}
            isSelected={selectedPieceId === piece.id}
            isSwapTarget={selectedPieceId !== null && selectedPieceId !== piece.id && hoveredPieceId === piece.id}
            isAutoSelecting={isAutoSelecting && hoveredPieceId === piece.id}
            onPointerDown={handlePointerDown}
          />
        ))}
      </motion.div>
    </div>
  );
}
