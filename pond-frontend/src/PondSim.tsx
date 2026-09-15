import './pond.css';
import { fetchScenarios, fetchSpecies } from './api';
import { useRef } from 'react';
import { useEffect } from 'react';
import { useState } from 'react';
import { loadPond } from "./wasm/loadPond";
import { Tooltip, Line, Area, ComposedChart, XAxis, YAxis, Legend } from 'recharts';

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
                <div className="chart-frame">
                    <ComposedChart width={800} height={500} data={history} >
                        <XAxis dataKey="day" domain={[0, duration_days.current]} ticks={Array.from({ length: Math.floor(duration_days.current / 10 + 1) }, (_, i) => i * 10)} niceTicks="none" />
                        <YAxis yAxisId="pop" />
                        <YAxis yAxisId="water" orientation="right" domain={[0, 1]} />
                        <Tooltip />
                        <Legend />
                        {/* <CartesianGrid strokeDasharray="3 3" stroke="#aed73e" /> */}
                        <Area yAxisId="water" type="monotone" dot={false} isAnimationActive={false} dataKey="water" fill="#8ab9ff00" stroke="#0046d1" />
                        <Line yAxisId="pop" type="monotone" dot={false} isAnimationActive={false} dataKey="algae" fill="#00941e" stroke="#00941e" />
                        <Line yAxisId="pop" type="monotone" dot={false} isAnimationActive={false} dataKey="invertebrates" fill="#6696a2" stroke="#6696a2" />
                        <Area yAxisId="pop" type="monotone" dot={false} isAnimationActive={false} dataKey="nutrients" fill="#7fa341" stroke="#7fa341" opacity={0.5} />
                    </ComposedChart>
                </div>
            </section>
        </main>
    </div>

    );
}

export default PondSim
