import type { ExecutiveTrendPoint } from '@/lib/admin-finance/executive-model';

type ExecutiveTrendChartProps = {
  points: ExecutiveTrendPoint[];
  todayKey: string;
};

const moneyFormatter = new Intl.NumberFormat('es-VE', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const exactMoneyFormatter = new Intl.NumberFormat('es-VE', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const weekdayFormatter = new Intl.DateTimeFormat('es-VE', {
  weekday: 'short',
  timeZone: 'America/Caracas',
});

function weekdayLabel(dateKey: string) {
  const label = weekdayFormatter.format(new Date(`${dateKey}T12:00:00-04:00`));
  return label.replace('.', '').slice(0, 3);
}

export default function ExecutiveTrendChart({ points, todayKey }: ExecutiveTrendChartProps) {
  const width = 640;
  const height = 210;
  const left = 16;
  const right = 12;
  const top = 16;
  const bottom = 12;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const maximum = Math.max(
    1,
    ...points.flatMap((point) => [point.currentBilledUsd ?? 0, point.historicalBilledUsd])
  );
  const coordinate = (value: number, index: number) => ({
    x: left + (points.length <= 1 ? chartWidth / 2 : (index / (points.length - 1)) * chartWidth),
    y: top + chartHeight - (Math.max(0, value) / maximum) * chartHeight,
  });
  const actualCoordinates = points.map((point, index) =>
    point.currentBilledUsd === null ? null : coordinate(point.currentBilledUsd, index)
  );
  const historicalCoordinates = points.map((point, index) =>
    coordinate(point.historicalBilledUsd, index)
  );
  const actualPath = actualCoordinates
    .filter((point): point is { x: number; y: number } => point !== null)
    .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(' ');
  const historicalPath = historicalCoordinates
    .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(' ');
  const actualTotal = points.findLast((point) => point.currentBilledUsd !== null)?.currentBilledUsd ?? 0;
  const historicalToDate =
    points.find((point) => point.dateKey === todayKey)?.historicalBilledUsd ?? 0;

  return (
    <figure className="min-w-0 rounded-xl border border-[#292937] bg-[#111117] p-3">
      <figcaption className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">Facturación semanal</h2>
          <p className="text-xs text-[#9B9BA7]">Acumulada · mismo día y hora</p>
        </div>
        <div className="text-right">
          <p className="text-base font-semibold tabular-nums text-white">{exactMoneyFormatter.format(actualTotal)}</p>
          <p className="text-xs tabular-nums text-[#8E8E9A]">
            Referencia a hoy {exactMoneyFormatter.format(historicalToDate)}
          </p>
        </div>
      </figcaption>

      <div className="mt-2 flex flex-wrap gap-3 text-xs text-[#B7B7C2]">
        <span className="inline-flex items-center gap-2">
          <span className="h-0.5 w-5 bg-[#FEEF00]" aria-hidden="true" />
          Semana actual
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-0.5 w-5 border-t border-dashed border-[#8F8FA3]" aria-hidden="true" />
          Promedio 4 semanas
        </span>
      </div>

      <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
        <div aria-hidden="true" className="flex h-40 flex-col justify-between py-3 text-[10px] tabular-nums text-[#9B9BA7] sm:h-44">
          {[maximum, maximum / 2, 0].map((value) => <span key={value}>{moneyFormatter.format(value)}</span>)}
        </div>
        <div className="min-w-0">
        <svg
          className="h-40 w-full sm:h-44"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="Facturación acumulada de la semana actual comparada con el promedio de las cuatro semanas anteriores"
        >
        {[0, 0.5, 1].map((fraction) => {
          const y = top + chartHeight - chartHeight * fraction;
          return (
            <line
              key={fraction}
              x1={left}
              x2={width - right}
              y1={y}
              y2={y}
              stroke="#2E2E3A"
              strokeWidth="1"
            />
          );
        })}
        <polyline
          points={historicalPath}
          fill="none"
          stroke="#8F8FA3"
          strokeDasharray="7 7"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="3"
        />
        <polyline
          points={actualPath}
          fill="none"
          stroke="#FEEF00"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="4"
        />
        {actualCoordinates.map((point, index) =>
          point ? (
            <circle
              key={points[index].dateKey}
              cx={point.x}
              cy={point.y}
              r={points[index].dateKey === todayKey ? 5 : 3.5}
              fill="#0B0B0D"
              stroke="#FEEF00"
              strokeWidth="3"
            />
          ) : null
        )}
        </svg>
        <div aria-hidden="true" className="flex justify-between text-[11px] text-[#A3A3AE]">
          {points.map((point) => <span key={point.dateKey} className={point.dateKey === todayKey ? 'font-semibold text-[#FEEF00]' : ''}>{weekdayLabel(point.dateKey)}</span>)}
        </div>
        </div>
      </div>

      <details className="mt-2 border-t border-[#292937]">
        <summary className="min-h-11 cursor-pointer content-center text-xs text-[#BDBDC7] focus-visible:outline-2 focus-visible:outline-[#FEEF00]">Ver cifras por día</summary>
      <div className="overflow-x-auto">
      <table className="w-full text-right text-xs tabular-nums text-[#CFCFD7] [&_td]:py-1.5 [&_th]:py-1.5">
        <caption className="sr-only">Facturación acumulada actual y promedio histórico</caption>
        <thead>
          <tr>
            <th>Día</th>
            <th>Actual</th>
            <th>Promedio histórico</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.dateKey}>
              <th>{point.dateKey}</th>
              <td>{point.currentBilledUsd === null ? 'Pendiente' : exactMoneyFormatter.format(point.currentBilledUsd)}</td>
              <td>{exactMoneyFormatter.format(point.historicalBilledUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      </details>
    </figure>
  );
}
