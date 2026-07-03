import './pond.css'
import { fetchScenarios, fetchSpecies } from './api';
import { useRef } from 'react';
import { useEffect } from 'react';
import { useState } from 'react';
import { loadPond } from "./wasm/loadPond";
import { Tooltip, Line, Area, Bar, ComposedChart, LineChart, XAxis, YAxis, Legend, CartesianGrid } from 'recharts';

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

const pondBaseline = {
    meta: { duration_days: 110, timestep_days: 0.01 },
    params: {} as Record<string, number>, 
    description: "No scenario selected"
};


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

    const [scenarios, setScenarios] = useState<any[]>([]);
    const [scenarioLoading, setScenarioLoading] = useState(false);
    const [species, setSpecies] = useState<any[]>([]);
    const [speciesLoading, setSpeciesLoading] = useState(false);
    const duration_days = useRef<any>(pondBaseline.meta.duration_days);
    const timestep_days = useRef<any>(pondBaseline.meta.timestep_days);
    const description = useRef<string>(pondBaseline.description);

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
    const applyScenario = (scenario: any) => {
        const config = scenario.config;
        duration_days.current = config.meta.duration_days;
        timestep_days.current = config.meta.timestep_days;
        for (const [key, value] of Object.entries(config.params ?? {})) {
            sim.current.setParam(key, value as number);
        }
        console.log(scenario);
        description.current = scenario.description;

        sim.current.reset();
        nextDayRef.current = 1;
        localHistoryRef.current = [];
        setHistory([]);

        console.log("Resetting simulation");
        console.log("Scenario config:", scenario.name);
        console.log("Scenario description:", description.current);
    };

    useEffect(() => {
        let cancelled = false;

        const loadScenarios = async () => {
            setScenarioLoading(true);
            try {
                const scenarios = await fetchScenarios();
                //console.log("scenarios:", scenarios);
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
                console.log("species:", species);
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
            //console.log("Scenario applied:", sim);
        }
        else {
            restartSimulation();
        }
    };

    function FieldGuide({ species }: { species: any[] }) {
    return (
        <div className="field-guide">
        {species.map((s) => (
            <div id="box" key={s.id} tabIndex={0}>
            {/* {s.image
                ? <img src={s.image} alt={s.name} className="species-img" />
                : <div className="species-img placeholder" />} */}
            <div className="species-name">{s.name}</div>
            {/* <div className="species-overlay"> */}
                <p>{s.description}</p>
            </div>
            // </div>
        ))}
        </div>
    );
    }

    const latestSample = history.length > 0 ? history[history.length - 1] : null;

    return (
    <section id="center"> 

        <div id="left">
            <h2>Aquatic Ecosystem Simulation: Vernal Pools</h2>
            <div style={{ fontSize: '16px', lineHeight: '1.5' }}>
                A vernal pool is a temporary wetland that fills with water during the rainy season and dries up during the summer months.
                They are a crucial ecological habitat for many species, and are highly affected by rising temperatures, less precipitation and agricultural practices.
            <br />
            <br />
            </div>
            <div id="box" style={{ fontSize: '16px', lineHeight: '1.5', margin: '10px 0' }}>
                <div>Description: {description.current}</div>
            </div>
            {/* <h3 style={{ fontSize: '20px', textAlign: 'left', color: 'var(--text-h)' }}>Species Guide</h3> */}
            <FieldGuide species={species} />
        </div>

        
        <section id="right">
            {/* <h2 style={{ fontSize: '14px', color: 'var(--text-h)' }}>Select an environmental scenario below to apply it to the simulation.<br /><br /></h2> */}
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
        </section>
    </section>

    );
}

export default PondSim