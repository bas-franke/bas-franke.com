import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Chart as ChartData } from '../types';

const COLORS = ['#d9480f', '#1f6f8b', '#e8a33d', '#5b8c5a', '#8e5ea2', '#c0392b'];

const fmt = (unit: string) => (v: number) => {
  const n = new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(v);
  return unit === '%' ? `${n}%` : unit ? `${n} ${unit}` : n;
};

export default function Chart({ chart }: { chart: ChartData }) {
  const data = chart.labels.map((label, i) => {
    const row: Record<string, string | number> = { label };
    for (const s of chart.series) row[s.name] = s.values[i] ?? 0;
    return row;
  });
  const f = fmt(chart.unit);
  const multi = chart.series.length > 1;

  const body = () => {
    switch (chart.type) {
      case 'pie': {
        const s = chart.series[0];
        const pieData = chart.labels.map((name, i) => ({ name, value: s?.values[i] ?? 0 }));
        return (
          <PieChart>
            <Pie data={pieData} dataKey="value" nameKey="name" innerRadius="45%" outerRadius="80%" paddingAngle={2} stroke="none">
              {pieData.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip formatter={(v) => f(Number(v))} />
            <Legend />
          </PieChart>
        );
      }
      case 'line':
      case 'area': {
        const Wrapper = chart.type === 'line' ? LineChart : AreaChart;
        return (
          <Wrapper data={data} margin={{ left: 8, right: 16, top: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e8e4dc" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} tickLine={false} axisLine={{ stroke: '#d8d3c8' }} />
            <YAxis tick={{ fontSize: 12 }} tickLine={false} axisLine={false} tickFormatter={(v) => f(Number(v))} width={64} />
            <Tooltip formatter={(v) => f(Number(v))} />
            {multi && <Legend />}
            {chart.series.map((s, i) =>
              chart.type === 'line' ? (
                <Line key={s.name} type="monotone" dataKey={s.name} stroke={COLORS[i % COLORS.length]} strokeWidth={2.5} dot={{ r: 3 }} />
              ) : (
                <Area key={s.name} type="monotone" dataKey={s.name} stroke={COLORS[i % COLORS.length]} fill={COLORS[i % COLORS.length]} fillOpacity={0.18} strokeWidth={2} />
              ),
            )}
          </Wrapper>
        );
      }
      default:
        return (
          <BarChart data={data} margin={{ left: 8, right: 16, top: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e8e4dc" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} tickLine={false} axisLine={{ stroke: '#d8d3c8' }} />
            <YAxis tick={{ fontSize: 12 }} tickLine={false} axisLine={false} tickFormatter={(v) => f(Number(v))} width={64} />
            <Tooltip formatter={(v) => f(Number(v))} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
            {multi && <Legend />}
            {chart.series.map((s, i) => (
              <Bar key={s.name} dataKey={s.name} fill={COLORS[i % COLORS.length]} radius={[4, 4, 0, 0]} />
            ))}
          </BarChart>
        );
    }
  };

  return (
    <figure className="chart">
      <figcaption>
        <strong>{chart.title}</strong>
        {chart.unit && <span className="chart-unit">{chart.unit}</span>}
      </figcaption>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height={300}>
          {body()}
        </ResponsiveContainer>
      </div>
      {chart.note && <p className="chart-note">{chart.note}</p>}
    </figure>
  );
}
