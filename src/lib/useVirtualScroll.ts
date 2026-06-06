import { useEffect, useState } from "react";

interface UseVirtualScrollOptions {
    containerRef: React.RefObject<HTMLElement>;
    itemCount: number;
    itemHeight: number;
    overscanCount?: number;
}

interface VirtualRange {
    startIndex: number;
    endIndex: number;
}

export function useVirtualScroll({
    containerRef,
    itemCount,
    itemHeight,
    overscanCount = 10,
}: UseVirtualScrollOptions): VirtualRange {
    const [range, setRange] = useState<VirtualRange>({
        startIndex: 0,
        endIndex: Math.min(50, itemCount),
    });

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const handleScroll = () => {
            const scrollTop = container.scrollTop;
            const visibleHeight = container.clientHeight;

            const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscanCount);
            const endIndex = Math.min(
                itemCount,
                Math.ceil((scrollTop + visibleHeight) / itemHeight) + overscanCount
            );

            setRange({ startIndex, endIndex });
        };

        const scrollElement = container.querySelector(".file-list");
        if (scrollElement) {
            scrollElement.addEventListener("scroll", handleScroll, { passive: true });
            return () => scrollElement.removeEventListener("scroll", handleScroll);
        }
    }, [containerRef, itemCount, itemHeight, overscanCount]);

    return range;
}
