import './pond.css';
import { fetchScenarios, fetchSpecies } from './api';
import { useRef } from 'react';
import { useEffect } from 'react';
import { useMemo } from 'react';
import { useState } from 'react';
import { loadPond } from "./wasm/loadPond";
// Legend is no longer imported: with one series per panel the panel heading
// carries the name, so the old chart's <Legend /> is redundant.
import { Tooltip, Line, Area, ComposedChart, XAxis, YAxis, ReferenceLine } from 'recharts';

//----------------------------------------------------------
// Type definitions for simulation data
//----------------------------------------------------------
type Sample = {
    day: number;
    algae: number;
    invertebrates: number;
    nutrients: number;
    water: number;
};

// A Sample plus the water-relative ratios the chart actually plots.
// Ratios are null while the pool is essentially dry (see waterRelative).
type ChartPoint = Sample & {
    algaePerWater: number | null;
    invertebratesPerWater: number | null;
    nutrientsPerWater: number | null;
};


//----------------------------------------------------------
// Water-relative ratios for the left chart axis
//
// The raw series are in three different units (g/m^2, ind/m^2, mg/L), so
// plotting them on one shared numeric axis makes that axis meaningless.
// Dividing each by the relative water level gives a dimensionless
// "amount per unit of remaining water" figure: as the pool dries, the same
// standing stock is concentrated into less water, so the ratio rises.
//
// Direction of the ratio: value / water ("amount per unit water").
// To flip to the reciprocal reading ("water per unit amount"), change the
// single return below to `water / value` (and guard against value === 0).
//
// Water reaches 0 at the end of the hydroperiod, so anything below
// minWaterForRatio is treated as dry and emits null; Recharts then draws a
// gap instead of a spike towards infinity.
//----------------------------------------------------------
const minWaterForRatio = 0.05;

function waterRelative(value: number, water: number): number | null {
    if (!Number.isFinite(value) || !Number.isFinite(water) || water < minWaterForRatio) {
        return null;
    }
    return value / water;
}

function toChartPoint(sample: Sample): ChartPoint {
    return {
        ...sample,
        algaePerWater: waterRelative(sample.algae, sample.water),
        invertebratesPerWater: waterRelative(sample.invertebrates, sample.water),
        nutrientsPerWater: waterRelative(sample.nutrients, sample.water)
    };
}

// Ratios are unitless but can be non-integer, so trim the decimals.
// Both formatters are now shared by the raw and per-water panels: raw values
// are non-integer too, and every panel wants the same tick/tooltip precision.
// Two decimals rather than one, because the panels auto-scale in real units
// and a small axis (nutrients in mg/L) can put a tick at 1.65, which one
// decimal would mislabel as 1.6.
const formatRatioTick = (value: number) =>
    Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));

const formatRatioValue = (value: unknown) =>
    typeof value === 'number' ? value.toFixed(2) : String(value ?? '');

// Superseded by the small multiples below: each panel now has its own y-axis in
// its own units and auto-scales to its own series, so there is no shared scale
// left to cap and nothing gets clipped.
//
// // As the pool empties, nutrients per unit water climb steeply (past 390 in the
// // enriched scenario) and flatten algae and invertebrates into the baseline.
// // Capping the visible axis keeps the normal 0-40 range readable; the nutrient
// // curve is clipped at the top rather than rescaling everything else away.
// const ratioAxisMax = 40;

//----------------------------------------------------------
// Small-multiple chart panels
//
// One quantity per panel, stacked over a single shared day axis.
// Each panel keeps its own y-axis in its own real units and
// auto-scales to its own series, so nothing is flattened against
// the floor or clipped at the ceiling by a shared scale.
//
// Every panel is given the same syncId, which is what makes the
// stack readable: hovering any day draws the cursor and tooltip
// in all four panels at once.
//
// Alignment is the pitfall. Recharts sizes a y-axis from its tick
// text unless told otherwise, and a wider axis eats into the plot
// area, so a panel whose ticks read "393" would be narrower than
// one reading "0.5" and the day axes would drift apart. Every
// panel therefore pins YAxis width to panelAxisWidth and reuses
// the same chart width and margin.
//----------------------------------------------------------
const panelWidth = 800;
const panelAxisWidth = 64;
const panelMargin = { top: 6, right: 22, bottom: 0, left: 6 };
const panelHeight = 152;        // one biological series
const waterPanelHeight = 120;   // shorter: water is bounded 0..1
const dayAxisHeight = 28;       // day labels, on the bottom panel only
const panelSyncId = 'pond-day';
const axisTextColor = '#d4de95';
const axisLineColor = '#636b2f';

type ChartMode = 'raw' | 'perWater';

type PanelSeries = {
    dataKey: keyof ChartPoint;
    heading: string;
    tooltipName: string;
    color: string;
    shape: 'line' | 'area';
    domain: [number | 'auto', number | 'auto'];
    tickCount: number;
};

// The heading is the only label a panel gets, so it carries the unit and
// changes with the mode: it must never be ambiguous which view is on screen.
// tooltipName is the short form, because four synced tooltips at once would
// otherwise cover the neighbouring panels.
const standingStockSeries: PanelSeries[] = [
    { dataKey: 'algae', heading: 'Algae (g/m²)', tooltipName: 'Algae (g/m²)', color: '#6b8852', shape: 'line', domain: ['auto', 'auto'], tickCount: 5 },
    { dataKey: 'invertebrates', heading: 'Invertebrates (ind/m²)', tooltipName: 'Invertebrates (ind/m²)', color: '#653007', shape: 'line', domain: ['auto', 'auto'], tickCount: 5 },
    { dataKey: 'nutrients', heading: 'Nutrients (mg/L)', tooltipName: 'Nutrients (mg/L)', color: '#251303', shape: 'line', domain: ['auto', 'auto'], tickCount: 5 }
];

const perWaterSeries: PanelSeries[] = [
    { dataKey: 'algaePerWater', heading: 'Algae per unit water (g/m² per relative depth)', tooltipName: 'Algae (g/m² per depth)', color: '#15A100', shape: 'line', domain: ['auto', 'auto'], tickCount: 5 },
    { dataKey: 'invertebratesPerWater', heading: 'Invertebrates per unit water (ind/m² per relative depth)', tooltipName: 'Invertebrates (ind/m² per depth)', color: '#C73E00', shape: 'line', domain: ['auto', 'auto'], tickCount: 5 },
    { dataKey: 'nutrientsPerWater', heading: 'Nutrients per unit water (mg/L per relative depth)', tooltipName: 'Nutrients (mg/L per depth)', color: '#D8E6C3', shape: 'area', domain: ['auto', 'auto'], tickCount: 5 }
];

// Water is the forcing function, not a mode-dependent quantity, so this panel
// is the same in both views and always sits at the bottom of the stack. Its
// domain is the model's own 0..1 range rather than an auto fit, and three ticks
// keep it to the round values 0, 0.5 and 1.
const waterPanelSeries: PanelSeries = {
    dataKey: 'water',
    heading: 'Water level (relative depth, 1 = full)',
    tooltipName: 'Water level',
    color: '#BFEDFF',
    shape: 'area',
    domain: [0, 1],
    tickCount: 3
};

const chartModeLabels: Record<ChartMode, string> = {
    raw: 'Standing stock',
    perWater: 'Per unit water'
};

type ChartPanelProps = {
    series: PanelSeries;
    data: (Sample | ChartPoint)[];
    height: number;
    dayDomain: [number, number];
    dayTicks: number[];
    showDayAxis: boolean;
    dryDay: number | null;
};

function ChartPanel({ series, data, height, dayDomain, dayTicks, showDayAxis, dryDay }: ChartPanelProps) {
    return (
        <div className="chart-panel">
            <div className="chart-panel-heading" style={{ color: series.color }}>{series.heading}</div>
            <ComposedChart
                syncId={panelSyncId}
                width={panelWidth}
                height={height + (showDayAxis ? dayAxisHeight : 0)}
                data={data}
                margin={panelMargin}
            >
                <XAxis
                    dataKey="day"
                    type="number"
                    domain={dayDomain}
                    ticks={dayTicks}
                    height={showDayAxis ? dayAxisHeight : 6}
                    tick={showDayAxis ? { fill: axisTextColor, fontSize: 11 } : false}
                    tickLine={showDayAxis}
                    stroke={axisLineColor}
                />
                <YAxis
                    width={panelAxisWidth}
                    domain={series.domain}
                    tickCount={series.tickCount}
                    interval={0}
                    tickFormatter={formatRatioTick}
                    tick={{ fill: axisTextColor, fontSize: 11 }}
                    stroke={axisLineColor}
                />
                <Tooltip
                    formatter={formatRatioValue}
                    labelFormatter={(day) => `Day ${day}`}
                    contentStyle={{ background: '#3d4127', border: `1px solid ${axisLineColor}`, borderRadius: 6, fontSize: 12 }}
                    labelStyle={{ color: axisTextColor }}
                    itemStyle={{ color: axisTextColor }}
                />
                {dryDay !== null && (
                    <ReferenceLine
                        x={dryDay}
                        stroke="#BFEDFF"
                        strokeDasharray="4 4"
                        label={{ value: `pool dry, day ${dryDay}`, position: 'insideTopLeft', fill: axisTextColor, fontSize: 10 }}
                    />
                )}
                {series.shape === 'area' ? (
                    <Area
                        type="monotone"
                        dot={false}
                        isAnimationActive={false}
                        connectNulls={false}
                        dataKey={series.dataKey}
                        name={series.tooltipName}
                        fill={series.color}
                        fillOpacity={0.35}
                        stroke={series.color}
                    />
                ) : (
                    <Line
                        type="monotone"
                        dot={false}
                        isAnimationActive={false}
                        connectNulls={false}
                        dataKey={series.dataKey}
                        name={series.tooltipName}
                        fill={series.color}
                        stroke={series.color}
                    />
                )}
            </ComposedChart>
        </div>
    );
}


type Species = {
    id: string;
    name: string;
    simKey?: string;
    trophicRole?: string;
    description: string;
};

type Scenario = {
    id: string;
    name: string;
    description: string;
    config: any;
};

const pondBaseline = {
    meta: { duration_days: 110, timestep_days: 0.01 },
    params: {} as Record<string, number>, 
    description: "No scenario selected"
};

const projectTitle = "Aquatic Ecosystem Simulation: Vernal Pools";

const projectDescription = [
    "A vernal pool is a temporary wetland that fills with water during the rainy season and dries up during the summer months. They are a crucial ecological habitat for many species, and are highly affected by rising temperatures, changes in precipitation and nearby agricultural practices.",
    "This simulator steps through a 'hydroperiod', a sequence of days where the pool is either wet or dry. A C++ model of the pool is compiled to WebAssembly and charts algae, invertebrates, nutrients and water volume day by day. Scenario parameters and species records are loaded from the project's Drupal JSON:API."
];


//---------------------------------------------------------
// Full-width header with the project title and help popover
//---------------------------------------------------------
function SiteHeader() {
    const [open, setOpen] = useState(false);
    const helpRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return;

        const handlePointerDown = (event: MouseEvent) => {
            if (helpRef.current && !helpRef.current.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setOpen(false);
            }
        };

        document.addEventListener('mousedown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);

        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [open]);

    return (
        <header className="site-header">
            <h1 className="site-title">{projectTitle}</h1>
            <div className="help" ref={helpRef}>
                <button
                    type="button"
                    className="help-button"
                    aria-label="About this project"
                    aria-expanded={open}
                    onClick={() => setOpen((previous) => !previous)}
                >
                    ?
                </button>
                {open && (
                    <div className="help-popover" role="dialog" aria-label="About this project">
                        {projectDescription.map((paragraph, index) => (
                            <p key={index}>{paragraph}</p>
                        ))}
                    </div>
                )}
            </div>
        </header>
    );
}


//---------------------------------------------------------
// Species list, each entry reveals its API description on hover
//---------------------------------------------------------
const tooltipWidth = 320;

function FieldGuide({ species }: { species: Species[] }) {
    const [hovered, setHovered] = useState<{ species: Species; top: number; left: number } | null>(null);

    // The list scrolls, so the card is positioned in viewport coordinates
    // instead of being clipped inside the panel.
    const show = (entry: Species, anchor: HTMLElement) => {
        const rect = anchor.getBoundingClientRect();
        const fitsRight = window.innerWidth - rect.right > tooltipWidth + 24;
        setHovered({
            species: entry,
            top: Math.max(12, Math.min(rect.top, window.innerHeight - 260)),
            left: fitsRight ? rect.right + 12 : Math.max(12, rect.left - tooltipWidth - 12)
        });
    };

    const hide = () => setHovered(null);

    if (species.length === 0) {
        return <div className="panel-empty">No species records returned by the API.</div>;
    }

    return (
        <>
            <ul className="field-guide" onScroll={hide}>
                {species.map((s) => (
                    <li key={s.id}>
                        <button
                            type="button"
                            className="species-item"
                            onMouseEnter={(event) => show(s, event.currentTarget)}
                            onMouseLeave={hide}
                            onFocus={(event) => show(s, event.currentTarget)}
                            onBlur={hide}
                        >
                            <span className="species-name">{s.name}</span>
                            {s.trophicRole && <span className="species-role">{s.trophicRole}</span>}
                        </button>
                    </li>
                ))}
            </ul>

            {hovered && (
                <div
                    className="species-tooltip"
                    role="tooltip"
                    style={{ top: hovered.top, left: hovered.left, width: tooltipWidth }}
                >
                    <div className="species-tooltip-name">{hovered.species.name}</div>
                    {hovered.species.trophicRole && (
                        <div className="species-tooltip-role">{hovered.species.trophicRole}</div>
                    )}
                    {hovered.species.description ? (
                        <div
                            className="species-tooltip-body"
                            dangerouslySetInnerHTML={{ __html: hovered.species.description }}
                        />
                    ) : (
                        <p className="species-tooltip-empty">No description available.</p>
                    )}
                </div>
            )}
        </>
    );
}


//---------------------------------------------------------
// Main component for the pond simulation
//---------------------------------------------------------
function PondSim() {
    const moduleRef = useRef<any | null>(null);
    const sim = useRef<any | null>(null);
    const anim = useRef<number | null>(null);

    const [history, setHistory] = useState<Sample[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const isRunningRef = useRef(false);
    const nextDayRef = useRef(1);
    const localHistoryRef = useRef<Sample[]>([]);
    const stepsPerFrame = 20;

    const [scenarios, setScenarios] = useState<Scenario[]>([]);
    const [scenarioLoading, setScenarioLoading] = useState(false);
    const [activeScenario, setActiveScenario] = useState<Scenario | null>(null);
    const [species, setSpecies] = useState<Species[]>([]);
    const [speciesLoading, setSpeciesLoading] = useState(false);
    // Which view the small multiples show. Raw standing stock is the default
    // because it is the true model output.
    const [chartMode, setChartMode] = useState<ChartMode>('raw');
    const duration_days = useRef<any>(pondBaseline.meta.duration_days);
    const timestep_days = useRef<any>(pondBaseline.meta.timestep_days);

    //--------- Load pond --------------------
    useEffect(() => {
        let cancelled = false;

        loadPond().then((mod) => {
            if (cancelled) return;
            moduleRef.current = mod;
            setLoaded(true);
        });

        return () => {
            cancelled = true;
            cancelLoop();
            if (sim.current) {
                sim.current.delete();
            }
        };
    }, []);

    //----------- Frame component ------------- 
    const frame = () => {
        if (!sim.current) {
            setIsRunning(false);
            isRunningRef.current = false;
            return;
        }

        let didUpdate = false;
        for (let i = 0; i < stepsPerFrame; i++) {
            sim.current.step(timestep_days.current);
            const time = sim.current.getTime();

            while (time >= nextDayRef.current && nextDayRef.current <= duration_days.current) {
                localHistoryRef.current.push({
                    day: nextDayRef.current,
                    algae: sim.current.getAlgae(),
                    invertebrates: sim.current.getInvertebrates(),
                    nutrients: sim.current.getNutrients(),
                    water: sim.current.getWaterVolume()
                });
                nextDayRef.current += 1;
                didUpdate = true;
            }

            if (time >= duration_days.current) {
                break;
            }
        }

        if (didUpdate) {
            setHistory([...localHistoryRef.current]);
        }

        if (sim.current.getTime() < duration_days.current && isRunningRef.current) {
            anim.current = requestAnimationFrame(frame);
        } else {
            setIsRunning(false);
            isRunningRef.current = false;
            anim.current = null;
        }
    };

    //---------------- Simulation control methods -------------
    const startSimulation = () => {
        if (!loaded || isRunning) return;
        if (!sim.current) {
            resetSim();
        }
        setIsRunning(true);
        isRunningRef.current = true;
        anim.current = requestAnimationFrame(frame);
    };

    const stopSimulation = () => {
        if (!isRunning) return;
        cancelLoop();
        setIsRunning(false);
        isRunningRef.current = false;
    };

    const restartSimulation = () => {
        if (!loaded) return;
        resetSim();
        setIsRunning(true);
        isRunningRef.current = true;
        anim.current = requestAnimationFrame(frame);
    };

    const cancelLoop = () => {
        if (anim.current !== null) {
            cancelAnimationFrame(anim.current);
            anim.current = null;
        }
    };

    const resetSim = () => {
        cancelLoop();
        if (sim.current) {
            sim.current.delete();
        }
        if (!moduleRef.current) {
            return;
        }
        sim.current = new moduleRef.current.PondSim();
        nextDayRef.current = 1;
        localHistoryRef.current = [];
        setHistory([]);
    };


    //----------- Scenario application -------------
    const applyScenario = (scenario: Scenario) => {
        const config = scenario.config;
        duration_days.current = config.meta.duration_days;
        timestep_days.current = config.meta.timestep_days;
        for (const [key, value] of Object.entries(config.params ?? {})) {
            sim.current.setParam(key, value as number);
        }
        setActiveScenario(scenario);

        sim.current.reset();
        nextDayRef.current = 1;
        localHistoryRef.current = [];
        setHistory([]);
    };

    useEffect(() => {
        let cancelled = false;

        const loadScenarios = async () => {
            setScenarioLoading(true);
            try {
                const scenarios = await fetchScenarios();
                if (!cancelled) {
                    setScenarios(scenarios);
                }
            } catch (error) {
                console.error('Error fetching scenarios:', error);
            } finally {
                if (!cancelled) {
                    setScenarioLoading(false);
                }
            }
        };

        loadScenarios();

        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        let cancelled = false;

        const loadSpecies = async () => {
            setSpeciesLoading(true);
            try {
                const species = await fetchSpecies();
                if (!cancelled) {
                    setSpecies(species);
                }
            } catch (error) {
                console.error('Error fetching species:', error);
            } finally {
                if (!cancelled) {
                    setSpeciesLoading(false);
                }
            }
        };

        loadSpecies();

        return () => {
            cancelled = true;
        };
    }, []);

    const handleScenarioSelect = (event: React.ChangeEvent<HTMLSelectElement>) => {
        const picked = scenarios.find((s) => s.id === event.target.value);
        if (picked) {
            resetSim();
            applyScenario(picked);
        }
        else {
            duration_days.current = pondBaseline.meta.duration_days;
            timestep_days.current = pondBaseline.meta.timestep_days;
            setActiveScenario(null);
            restartSimulation();
        }
    };

    const latestSample = history.length > 0 ? history[history.length - 1] : null;

    // history always keeps the raw model output; the per-water ratios are
    // derived for the chart only, and only while that mode is showing. Raw
    // mode needs no dry-pool guard, so it plots the samples untouched.
    const chartData = useMemo<(Sample | ChartPoint)[]>(
        () => (chartMode === 'perWater' ? history.map(toChartPoint) : history),
        [history, chartMode]
    );

    // Day the pool goes dry, for the reference line. Normally that is the first
    // sample whose water level has reached 0. The model clock stops the moment
    // the pool empties, though, so a pool that empties part-way through a day
    // never logs a zero sample; in that case ask the model directly, exactly as
    // the status readout does, and mark the last day it recorded. Slow drying
    // can leave water in the pool all run, and then there is no line to draw.
    const modelIsDry = sim.current ? sim.current.getWaterVolume() <= 0 : false;
    const dryDay = history.find((s) => s.water <= 0)?.day
        ?? (modelIsDry && latestSample ? latestSample.day : null);

    const dayDomain: [number, number] = [0, duration_days.current];
    const dayTicks = Array.from({ length: Math.floor(duration_days.current / 10 + 1) }, (_, i) => i * 10);
    const panels = [...(chartMode === 'perWater' ? perWaterSeries : standingStockSeries), waterPanelSeries];

    return (
    <div className="app-shell">
        <SiteHeader />

        <main className="pond-layout">
            <div className="info-column">
                <section className="panel">
                    <h2 className="panel-title">Scenario</h2>
                    <div className="panel-body">
                        {scenarioLoading ? (
                            <div>Loading scenarios...</div>
                        ) : activeScenario ? (
                            <>
                                <h3 className="scenario-name">{activeScenario.name}</h3>
                                {activeScenario.description ? (
                                    <p className="scenario-description">{activeScenario.description}</p>
                                ) : (
                                    <p className="scenario-description">No description available.</p>
                                )}
                            </>
                        ) : (
                            <p className="scenario-description">{pondBaseline.description}</p>
                        )}
                    </div>
                </section>

                <section className="panel">
                    <h2 className="panel-title">Species</h2>
                    <p className="panel-hint">Hover over a species to read its description.</p>
                    {speciesLoading ? (
                        <div className="panel-body">Loading species...</div>
                    ) : (
                        <FieldGuide species={species} />
                    )}
                </section>
            </div>

            <section className="chart-column">
                <section id="row">
                    {scenarioLoading ? (
                        <div>Loading scenarios...</div>
                    ) : (
                    <select onChange={handleScenarioSelect}>
                        <option value="">Select a scenario</option>
                        {scenarios.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                    </select>
                    )}
                    <div>
                        <button onClick={startSimulation} disabled={!loaded || isRunning}>
                            Start
                        </button>
                        <button onClick={stopSimulation} disabled={!loaded || !isRunning}>
                            Stop
                        </button>
                        <button onClick={restartSimulation} disabled={!loaded}>
                            Restart
                        </button>
                    </div>

                    {latestSample && latestSample.day === pondBaseline.meta.duration_days || sim.current?.getWaterVolume() <= 0 ? (
                        <div>
                            Day {latestSample?.day}: {sim.current.name} Hydroperiod complete, water level at 0.
                        </div>
                    ) : (
                        <div>Day: {latestSample ? latestSample.day : 0}</div>
                    )}
                </section>
                {/*
                    Kept for reference: the original single overlaid ComposedChart, all four
                    series on two shared y-axes. (The CartesianGrid line below was already
                    commented out in that version; its comment markers are stripped here so
                    they do not close this block early.)

                    <ComposedChart width={800} height={500} data={chartData} >
                        <XAxis dataKey="day" domain={[0, duration_days.current]} ticks={Array.from({ length: Math.floor(duration_days.current / 10 + 1) }, (_, i) => i * 10)} niceTicks="none" />
                        <YAxis yAxisId="pop" domain={[0, ratioAxisMax]} allowDataOverflow tickFormatter={formatRatioTick} />
                        <YAxis yAxisId="water" orientation="right" domain={[0, 1]} stroke="#BFEDFF" opacity={0.5} />
                        <Tooltip formatter={formatRatioValue} />
                        <Legend />
                        <CartesianGrid strokeDasharray="3 3" stroke="#aed73e" />
                        <Area yAxisId="water" type="monotone" dot={false} isAnimationActive={false} dataKey="water" name="Water Level" fill="#BFEDFF" fillOpacity={0.25} stroke="#BFEDFF" />
                        <Line yAxisId="pop" type="monotone" dot={false} isAnimationActive={false} dataKey="algaePerWater" name="Algae" fill="#15A100" stroke="#15A100" />
                        <Line yAxisId="pop" type="monotone" dot={false} isAnimationActive={false} dataKey="invertebratesPerWater" name="Invertebrates" fill="#C73E00" stroke="#C73E00" />
                        <Area yAxisId="pop" type="monotone" dot={false} isAnimationActive={false} dataKey="nutrientsPerWater" name="Nutrients" fill="#D8E6C3" stroke="#D8E6C3" fillOpacity={0.5} />
                    </ComposedChart>
                */}

                <div className="chart-mode" role="group" aria-label="Chart view mode">
                    <span className="chart-mode-label">View:</span>
                    {(Object.keys(chartModeLabels) as ChartMode[]).map((mode) => (
                        <button
                            key={mode}
                            type="button"
                            className={mode === chartMode ? 'chart-mode-button is-active' : 'chart-mode-button'}
                            aria-pressed={mode === chartMode}
                            onClick={() => setChartMode(mode)}
                        >
                            {chartModeLabels[mode]}
                        </button>
                    ))}
                </div>

                <div className="chart-frame">
                    {panels.map((series, index) => (
                        <ChartPanel
                            key={series.dataKey}
                            series={series}
                            data={chartData}
                            height={series === waterPanelSeries ? waterPanelHeight : panelHeight}
                            dayDomain={dayDomain}
                            dayTicks={dayTicks}
                            showDayAxis={index === panels.length - 1}
                            dryDay={dryDay}
                        />
                    ))}
                    <div className="chart-axis-label">Day of hydroperiod</div>
                </div>

                <div className="chart-caption">
                    <p> <b>How to understand this simulation: <br></br></b>
                        The above simulation has four panels, one quantity each over a shared day axis. 
                        If you hover any panel on a given day, the y-axes of all panels will show the values for
                        the respective elements of the vernal pool ecosystem. Each panel is independent, 
                        but the day axis is shared, so the timing of events lines up across panels. 
                        The y-axes are in their own units, so vertical positions are only comparable within a panel.
                    </p>
                    {/* <p> <b>What to look out for within each simulation:</b>
                        Algae and invertebrates cycle out of phase, with algae
                        leading and invertebrates following about a quarter of a period later. Nutrients
                        dip sharply during an algae bloom, as uptake outruns recycling, then recover
                        after the algae crash. With these parameter values the cycles do not continue
                        forever: the system slowly damps toward a coexistence equilibrium. Spiking the
                        nutrient input instead produces eutrophication, a rapid algae bloom followed by
                        a crash, standing in for agricultural runoff or fertiliser pollution.
                    </p> */}
                    <p>
                        <strong>Standing stock</strong> plots the model output as it is, in g/m², ind/m²
                        and mg/L. <strong>Per unit water</strong> divides each biological series by the
                        relative water level, showing how the same standing stock is concentrated into a
                        shrinking pool; once the pool is essentially dry the ratio stops being meaningful,
                        so those lines break off rather than running away upward. 
                    </p>
                </div>
            </section>
        </main>
    </div>

    );
}

export default PondSim
