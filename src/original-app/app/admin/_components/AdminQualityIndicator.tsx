import type { AdminFinanceAccountSnapshot } from '@/lib/admin-finance/accounts-model';

type AdminFinanceQuality = AdminFinanceAccountSnapshot['quality'];

type AdminQualityIndicatorProps = {
  quality: AdminFinanceQuality;
  showLabel?: boolean;
  className?: string;
};

const QUALITY_META: Record<
  AdminFinanceQuality,
  { label: string; description: string; dotClass: string; labelClass: string }
> = {
  Q1_exact: {
    label: 'Exacto',
    description: 'Datos completos con fuente estructurada.',
    dotClass: 'bg-emerald-300',
    labelClass: 'text-emerald-200',
  },
  Q2_derived: {
    label: 'Derivado',
    description: 'Cifra calculada a partir de datos disponibles.',
    dotClass: 'bg-blue-300',
    labelClass: 'text-blue-200',
  },
  Q3_incomplete: {
    label: 'Parcial',
    description: 'La cifra tiene cobertura conocida pero incompleta.',
    dotClass: 'bg-orange-300',
    labelClass: 'text-orange-200',
  },
  Q4_blocked: {
    label: 'No disponible',
    description: 'No existe una base suficiente para publicar la cifra.',
    dotClass: 'bg-[#777784]',
    labelClass: 'text-[#B8B8C2]',
  },
};

export function AdminQualityIndicator({
  quality,
  showLabel = true,
  className = '',
}: AdminQualityIndicatorProps) {
  const meta = QUALITY_META[quality];

  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}
      title={meta.description}
      aria-label={`${meta.label}. ${meta.description}`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dotClass}`} aria-hidden="true" />
      {showLabel ? (
        <span className={`truncate text-[11px] font-semibold ${meta.labelClass}`}>{meta.label}</span>
      ) : (
        <span className="sr-only">{meta.label}</span>
      )}
    </span>
  );
}

export default AdminQualityIndicator;
export type { AdminQualityIndicatorProps };
