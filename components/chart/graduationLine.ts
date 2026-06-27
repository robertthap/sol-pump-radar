"use client";

/**
 * Vertical dashed line at DEX graduation time (Axiom-style regime boundary).
 */

import type {
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  IChartApiBase,
  Time,
} from "lightweight-charts";
import { CHART_THEME } from "@/components/chart/chartTheme";

type CanvasRenderingTarget2D = Parameters<IPrimitivePaneRenderer["draw"]>[0];

class GraduationLineRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly _x: number | null) {}

  draw(target: CanvasRenderingTarget2D): void {
    const xMedia = this._x;
    if (xMedia === null) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const x = xMedia * hr;
      const h = scope.bitmapSize.height;

      ctx.save();
      // Vertical regime boundary line.
      ctx.strokeStyle = CHART_THEME.accent;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = Math.max(1, 1 * hr);
      ctx.setLineDash([4 * hr, 4 * hr]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();

      // "Migration" pill label near the top of the line.
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const text = "Migration";
      ctx.font = `${10 * vr}px ui-sans-serif, system-ui, sans-serif`;
      const padX = 5 * hr;
      const tw = ctx.measureText(text).width;
      const boxW = tw + padX * 2;
      const boxH = 15 * vr;
      const boxY = 4 * vr;
      let boxX = x + 3 * hr;
      if (boxX + boxW > scope.bitmapSize.width) boxX = x - boxW - 3 * hr;
      ctx.fillStyle = CHART_THEME.accent;
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxW, boxH, 3 * hr);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.textBaseline = "middle";
      ctx.fillText(text, boxX + padX, boxY + boxH / 2);
      ctx.restore();
    });
  }
}

class GraduationLinePaneView implements IPrimitivePaneView {
  private _x: number | null = null;

  constructor(private readonly _source: GraduationLinePrimitive) {}

  update(): void {
    const chart = this._source.chart;
    const at = this._source.graduationTimeSec;
    if (!chart || at == null) {
      this._x = null;
      return;
    }
    this._x = chart.timeScale().timeToCoordinate(at as Time);
  }

  renderer(): IPrimitivePaneRenderer {
    return new GraduationLineRenderer(this._x);
  }

  zOrder(): PrimitivePaneViewZOrder {
    return "bottom";
  }
}

export class GraduationLinePrimitive implements ISeriesPrimitive<Time> {
  chart: IChartApiBase<Time> | null = null;
  graduationTimeSec: number | null = null;

  private readonly _paneView: GraduationLinePaneView;
  private _requestUpdate?: () => void;

  constructor() {
    this._paneView = new GraduationLinePaneView(this);
  }

  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart;
    this._requestUpdate = p.requestUpdate;
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(this._onRange);
  }

  detached(): void {
    this.chart?.timeScale().unsubscribeVisibleLogicalRangeChange(this._onRange);
    this.chart = null;
    this._requestUpdate = undefined;
  }

  private _onRange = (): void => {
    this._paneView.update();
    this._requestUpdate?.();
  };

  updateAllViews(): void {
    this._paneView.update();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._paneView];
  }

  setGraduationTime(timeSec: number | null): void {
    this.graduationTimeSec = timeSec;
    this._paneView.update();
    this._requestUpdate?.();
  }
}
