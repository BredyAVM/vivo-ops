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
  const bottom = 30;
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
    <figure className="min-w-0 rounded-2xl border border-[#292937] bg-[#111117] p-4 sm:p-5">
      <figcaption className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#8E8E9A]">
            Tendencia acumulada
          </p>
          <h2 className="mt-1 text-base font-semibold text-white">Facturación semanal</h2>
        </div>
        <div className="text-right">
          <p className="text-xl font-semibold tabular-nums text-white">{moneyFormatter.format(actualTotal)}</p>
          <p className="text-xs tabular-nums text-[#8E8E9A]">
            Referencia a hoy {moneyFormatter.format(historicalToDate)}
          </p>
        </div>
      </figcaption>

      <div className="mt-3 flex flex-wrap gap-4 text-[11px] font-semibold text-[#B7B7C2]">
        <span className="inline-flex items-center gap-2">
          <span className="h-0.5 w-5 bg-[#FEEF00]" aria-hidden="true" />
          Semana actual
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-0.5 w-5 border-t border-dashed border-[#8F8FA3]" aria-hidden="true" />
          Promedio 4 semanas
        </span>
      </div>

      <div className="-mx-2 mt-3 overflow-x-auto px-2 pb-1">
        <svg
          className="h-auto min-w-[520px] w-full overflow-visible"
          viewBox={`0 0 ${width} ${height}`}
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
        {points.map((point, index) => {
          const coordinatePoint = coordinate(point.historicalBilledUsd, index);
          return (
            <text
              key={point.dateKey}
              x={coordinatePoint.x}
              y={height - 6}
              fill={point.dateKey === todayKey ? '#FEEF00' : '#8E8E9A'}
              fontSize="12"
              fontWeight={point.dateKey === todayKey ? '700' : '600'}
              textAnchor="middle"
            >
              {weekdayLabel(point.dateKey)}
            </text>
          );
        })}
        </svg>
      </div>

      <table className="sr-only">
        <caption>Facturación acumulada actual y promedio histórico</caption>
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
              <td>{point.currentBilledUsd === null ? 'Pendiente' : moneyFormatter.format(point.currentBilledUsd)}</td>
              <td>{moneyFormatter.format(point.historicalBilledUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
