'use client';

export type CheckState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; elapsedMs: number; detail?: string }
  | { status: 'fail'; elapsedMs: number; detail?: string; error: string };

interface StatusCheckProps {
  name: string;
  state: CheckState;
}

export function StatusCheck({ name, state }: StatusCheckProps) {
  const { icon, color } = presentation(state);
  return (
    <li className="flex items-start gap-3 rounded border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800">
      <span className={`mt-0.5 w-4 text-center ${color}`}>{icon}</span>
      <div className="flex-1">
        <div className="flex items-center justify-between gap-4">
          <span className="font-medium">{name}</span>
          {state.status === 'ok' || state.status === 'fail' ? (
            <span className="text-xs text-neutral-500">{state.elapsedMs}ms</span>
          ) : null}
        </div>
        {state.status === 'ok' && state.detail && (
          <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] text-neutral-500">
            {state.detail}
          </pre>
        )}
        {state.status === 'fail' && (
          <div className="mt-1 text-xs text-red-600 dark:text-red-400">
            {state.error}
            {state.detail && (
              <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px]">
                {state.detail}
              </pre>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function presentation(state: CheckState): { icon: string; color: string } {
  switch (state.status) {
    case 'idle':
      return { icon: '·', color: 'text-neutral-400' };
    case 'running':
      return { icon: '…', color: 'text-amber-500' };
    case 'ok':
      return { icon: '✓', color: 'text-emerald-600 dark:text-emerald-400' };
    case 'fail':
      return { icon: '✗', color: 'text-red-600 dark:text-red-400' };
  }
}
