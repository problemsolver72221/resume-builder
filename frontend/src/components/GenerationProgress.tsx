'use client';

export type GenerationProgressState = {
  total: number;
  completed: number;
  phase: string;
  currentProfileName?: string;
  currentCompanyName?: string;
};

type GenerationProgressProps = {
  progress: GenerationProgressState;
  className?: string;
};

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

export default function GenerationProgress({ progress, className = '' }: GenerationProgressProps) {
  const activeIndex = progress.currentProfileName || progress.currentCompanyName
    ? Math.min(progress.completed + 1, progress.total)
    : Math.min(progress.completed, progress.total);
  const displayedPercent = progress.total > 0
    ? clampPercentage(((progress.completed + (activeIndex > progress.completed ? 0.45 : 0)) / progress.total) * 100)
    : 0;
  const completedLabel = `${Math.min(progress.completed, progress.total)} / ${progress.total}`;

  return (
    <div className={`rounded-xl border border-blue-200 bg-blue-50/80 px-4 py-4 ${className}`.trim()}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-blue-900">{progress.phase}</div>
          <div className="mt-1 text-sm text-blue-800">
            {activeIndex > 0 ? `Resume ${activeIndex} of ${progress.total}` : `Preparing ${progress.total} resume(s)`}
          </div>
          <div className="mt-1 text-sm text-blue-700">
            {progress.currentProfileName
              ? `Building ${progress.currentProfileName}${progress.currentCompanyName ? ` for ${progress.currentCompanyName}` : ''}`
              : 'Preparing generation queue'}
          </div>
        </div>
        <div className="shrink-0 text-sm font-medium text-blue-900">{completedLabel}</div>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100">
        <div
          className="h-full rounded-full bg-blue-600 transition-[width] duration-300 ease-out"
          style={{ width: `${displayedPercent}%` }}
        />
      </div>
    </div>
  );
}
