type FinancialBarChartRow = {
  label: string;
  primary: number;
  secondary?: number;
};

type FinancialBarChartProps = {
  title: string;
  description: string;
  rows: FinancialBarChartRow[];
  primaryLabel: string;
  secondaryLabel?: string;
  primaryTone?: 'yellow' | 'emerald';
};

const numberFormatter = new Intl.NumberFormat('es-VE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function shortLabel(value: string) {
  const parts = value.split('/');
  const firstDay = parts[0]?.slice(8) || value;
  return parts.length > 1 ? `${firstDay}–${parts[1]}` : firstDay;
}

export default function FinancialBarChart({
  title,
  description,
  rows,
  primaryLabel,
  secondaryLabel,
  primaryTone = 'yellow',
}: FinancialBarChartProps) {
  const maximum = Math.max(
    1,
    ...rows.flatMap((row) => [Math.max(0, row.primary), Math.max(0, row.secondary ?? 0)])
  );
  const primaryTotal = rows.reduce((total, row) => total + row.primary, 0);
  const secondaryTotal = rows.reduce((total, row) => total + (row.secondary ?? 0), 0);
  const primaryClass = primaryTone === 'emerald' ? 'bg-emerald-400' : 'bg-[#FEEF00]';

  return (
    <figure className="rounded-2xl border border-[#292937] bg-[#111117] p-5 sm:p-6">
      <figcaption>
        <h3 className="text-base font-semibold text-white">{title}</h3>
        <p className="mt-1 text-sm leading-6 text-[#A5A5B1]">{description}</p>
      </figcaption>

      <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-xs font-semibold text-[#C9C9D2]">
        <span className="inline-flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-sm ${primaryClass}`} aria-hidden="true" />
          {primaryLabel}
        </span>
        {secondaryLabel ? (
          <span className="inline-flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-sm bg-orange-400" aria-hidden="true" />
            {secondaryLabel}
          </span>
        ) : null}
      </div>

      <div
        className="mt-5 grid h-44 items-end gap-1.5 border-b border-[#333342] px-1 sm:gap-2"
        style={{ gridTemplateColumns: `repeat(${Math.max(rows.length, 1)}, minmax(0, 1fr))` }}
        aria-hidden="true"
      >
        {rows.length === 0 ? (
          <div className="col-span-full self-center text-center text-sm text-[#8F8F9B]">Sin puntos en este período</div>
        ) : (
          rows.map((row) => {
            const primaryHeight = Math.max(row.primary > 0 ? 3 : 0, (Math.max(0, row.primary) / maximum) * 100);
            const secondaryHeight = Math.max(
              (row.secondary ?? 0) > 0 ? 3 : 0,
              (Math.max(0, row.secondary ?? 0) / maximum) * 100
            );
            return (
              <div key={row.label} className="flex h-full min-w-0 flex-col justify-end">
                <div className="flex h-36 items-end justify-center gap-0.5 sm:gap-1">
                  <span
                    className={`w-full max-w-7 rounded-t-md ${primaryClass}`}
                    style={{ height: `${primaryHeight}%` }}
                  />
                  {secondaryLabel ? (
                    <span
                      className="w-full max-w-7 rounded-t-md bg-orange-400"
                      style={{ height: `${secondaryHeight}%` }}
                    />
                  ) : null}
                </div>
                <span className="mt-2 truncate text-center text-[11px] font-semibold text-[#9D9DA8]">
                  {shortLabel(row.label)}
                </span>
              </div>
            );
          })
        )}
      </div>

      <dl className={rows.length <= 3 ? 'mt-4 grid gap-2 sm:grid-cols-2' : 'mt-4 flex flex-wrap gap-2'}>
        {rows.length <= 3 ? rows.map((row) => (
          <div key={row.label} className="rounded-xl border border-[#2C2C39] bg-[#17171F] px-3 py-2.5">
            <dt className="text-xs font-semibold text-[#A6A6B1]">{row.label}</dt>
            <dd className="mt-1 text-sm font-semibold text-white">
              {primaryLabel}: ${numberFormatter.format(row.primary)}
              {secondaryLabel ? (
                <span className="mt-0.5 block text-orange-200">
                  {secondaryLabel}: ${numberFormatter.format(row.secondary ?? 0)}
                </span>
              ) : null}
            </dd>
          </div>
        )) : (
          <>
            <div className="rounded-full border border-[#333342] bg-[#17171F] px-3 py-1.5">
              <dt className="inline text-xs text-[#A6A6B1]">{primaryLabel}: </dt>
              <dd className="inline text-xs font-semibold text-white">${numberFormatter.format(primaryTotal)}</dd>
            </div>
            {secondaryLabel ? (
              <div className="rounded-full border border-orange-400/20 bg-orange-400/5 px-3 py-1.5">
                <dt className="inline text-xs text-orange-100/80">{secondaryLabel}: </dt>
                <dd className="inline text-xs font-semibold text-orange-100">${numberFormatter.format(secondaryTotal)}</dd>
              </div>
            ) : null}
          </>
        )}
      </dl>
      {rows.length > 3 ? (
        <dl className="sr-only">
          {rows.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>
                {primaryLabel}: ${numberFormatter.format(row.primary)}
                {secondaryLabel ? `; ${secondaryLabel}: $${numberFormatter.format(row.secondary ?? 0)}` : ''}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </figure>
  );
}
