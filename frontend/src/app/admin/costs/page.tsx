'use client';

// Phase 8 Task 1: Admin → Costs.
//
// Reads cost_log via /admin/costs/{summary,by-meeting,by-day} and
// renders a single dashboard page showing:
//   - Month-to-date total + all-time total + call count
//   - Per-endpoint breakdown (table)
//   - Last-30-day daily sparkline (inline divs, no chart lib)
//   - Top 25 most-expensive meetings
//
// Today this is unauthenticated and local-only. When the auth/license
// backend lands we'll gate it behind an admin role.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, RefreshCw } from 'lucide-react';

const BACKEND = 'http://localhost:5167';

interface Summary {
  all_time: {
    total_cost: number;
    total_input: number;
    total_output: number;
    total_audio_sec: number;
    calls: number;
  };
  month_to_date: {
    total_cost: number;
    calls: number;
  };
  by_endpoint: Array<{
    endpoint: string;
    calls: number;
    cost: number;
    input_tokens: number;
    output_tokens: number;
  }>;
}

interface DayRow {
  day: string;
  calls: number;
  cost: number;
}

interface MeetingRow {
  meeting_id: string;
  title: string;
  created_at: string;
  calls: number;
  cost: number;
  audio_seconds: number;
  input_tokens: number;
  output_tokens: number;
}

function fmtUsd(n: number): string {
  if (n == null) return '$0.00';
  if (n < 0.01 && n > 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n == null) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDuration(seconds: number): string {
  if (!seconds) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.round(seconds)}s`;
}

function fmtDate(iso: string): string {
  if (!iso) return '';
  try {
    const dt = new Date(iso);
    if (isNaN(dt.getTime())) return iso;
    return dt.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

export default function AdminCostsPage() {
  const router = useRouter();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [byDay, setByDay] = useState<DayRow[]>([]);
  const [byMeeting, setByMeeting] = useState<MeetingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [s, d, m] = await Promise.all([
        fetch(`${BACKEND}/admin/costs/summary`).then((r) => r.json()),
        fetch(`${BACKEND}/admin/costs/by-day?days=30`).then((r) => r.json()),
        fetch(`${BACKEND}/admin/costs/by-meeting?limit=25`).then((r) => r.json()),
      ]);
      setSummary(s);
      setByDay(d);
      setByMeeting(m);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Failed to load cost data: ${msg}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const maxDayCost = Math.max(0.0001, ...byDay.map((d) => d.cost));

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Admin · Cost dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Gemini API spend across transcription, summary, embeddings,
              and /ask. Data lives in <code>cost_log</code>.
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border text-sm hover:bg-muted disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            Refresh
          </button>
        </div>

        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-md text-sm text-red-800">
            {error}
          </div>
        )}

        {summary && (
          <>
            {/* Top stat cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <StatCard
                label="Month to date"
                value={fmtUsd(summary.month_to_date.total_cost)}
                sub={`${summary.month_to_date.calls} calls`}
              />
              <StatCard
                label="All time"
                value={fmtUsd(summary.all_time.total_cost)}
                sub={`${summary.all_time.calls} calls`}
              />
              <StatCard
                label="Tokens (all time)"
                value={`${fmtTokens(summary.all_time.total_input)} in`}
                sub={`${fmtTokens(summary.all_time.total_output)} out`}
              />
              <StatCard
                label="Audio transcribed"
                value={fmtDuration(summary.all_time.total_audio_sec)}
                sub="across all meetings"
              />
            </div>

            {/* Per-endpoint breakdown */}
            <section className="rounded-lg border bg-card">
              <div className="px-4 py-3 border-b">
                <h2 className="font-medium">By endpoint</h2>
              </div>
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground bg-muted/40">
                  <tr>
                    <th className="px-4 py-2 font-medium">Endpoint</th>
                    <th className="px-4 py-2 font-medium text-right">Calls</th>
                    <th className="px-4 py-2 font-medium text-right">Input tokens</th>
                    <th className="px-4 py-2 font-medium text-right">Output tokens</th>
                    <th className="px-4 py-2 font-medium text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.by_endpoint.map((row) => (
                    <tr key={row.endpoint} className="border-t">
                      <td className="px-4 py-2 font-mono text-xs">{row.endpoint}</td>
                      <td className="px-4 py-2 text-right">{row.calls.toLocaleString()}</td>
                      <td className="px-4 py-2 text-right">{fmtTokens(row.input_tokens)}</td>
                      <td className="px-4 py-2 text-right">{fmtTokens(row.output_tokens)}</td>
                      <td className="px-4 py-2 text-right font-medium">{fmtUsd(row.cost)}</td>
                    </tr>
                  ))}
                  {summary.by_endpoint.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                        No cost data yet. Use the app, then refresh.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>

            {/* Daily sparkline */}
            <section className="rounded-lg border bg-card">
              <div className="px-4 py-3 border-b">
                <h2 className="font-medium">Last 30 days</h2>
              </div>
              <div className="p-4">
                {byDay.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No daily activity yet.
                  </p>
                ) : (
                  <div className="flex items-end gap-1 h-32">
                    {byDay.map((d) => {
                      const h = Math.max(2, (d.cost / maxDayCost) * 120);
                      return (
                        <div
                          key={d.day}
                          className="flex-1 bg-blue-500/70 hover:bg-blue-500 rounded-t"
                          style={{ height: `${h}px` }}
                          title={`${d.day}: ${fmtUsd(d.cost)} (${d.calls} calls)`}
                        />
                      );
                    })}
                  </div>
                )}
                {byDay.length > 0 && (
                  <div className="flex justify-between text-xs text-muted-foreground mt-2">
                    <span>{byDay[0]?.day}</span>
                    <span>{byDay[byDay.length - 1]?.day}</span>
                  </div>
                )}
              </div>
            </section>

            {/* Top expensive meetings */}
            <section className="rounded-lg border bg-card">
              <div className="px-4 py-3 border-b">
                <h2 className="font-medium">Top 25 most-expensive meetings</h2>
              </div>
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground bg-muted/40">
                  <tr>
                    <th className="px-4 py-2 font-medium">Meeting</th>
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 font-medium text-right">Audio</th>
                    <th className="px-4 py-2 font-medium text-right">Calls</th>
                    <th className="px-4 py-2 font-medium text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {byMeeting.map((m) => (
                    <tr
                      key={m.meeting_id}
                      className="border-t hover:bg-muted/30 cursor-pointer"
                      onClick={() =>
                        router.push(`/meeting-details?id=${m.meeting_id}`)
                      }
                    >
                      <td className="px-4 py-2 truncate max-w-xs">{m.title}</td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {fmtDate(m.created_at)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {fmtDuration(m.audio_seconds)}
                      </td>
                      <td className="px-4 py-2 text-right">{m.calls}</td>
                      <td className="px-4 py-2 text-right font-medium">
                        {fmtUsd(m.cost)}
                      </td>
                    </tr>
                  ))}
                  {byMeeting.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                        No meeting-attributed cost data yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-xs text-muted-foreground uppercase tracking-wide">
        {label}
      </div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {sub && (
        <div className="text-xs text-muted-foreground mt-1">{sub}</div>
      )}
    </div>
  );
}
