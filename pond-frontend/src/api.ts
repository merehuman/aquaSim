//const API = "https://eco-explore.ddev.site";
const API = import.meta.env.VITE_API_URL;

export async function fetchSpecies() {
  const res = await fetch(`${API}/jsonapi/node/species`);
  const json = await res.json();
  return json.data.map((n: any) => ({
    id: n.id,
    name: n.attributes.title,
    simKey: n.attributes.field_sim_key,
    trophicRole: n.attributes.field_trophic_role,
    description: n.attributes.field_description?.value ?? "",
  }));
}

export async function fetchScenarios() {
  const res = await fetch(`${API}/jsonapi/node/scenario`);
  if (!res.ok) {
    throw new Error(`Scenario fetch error! status: ${res.status}`);
  }
  const json = await res.json();
  console.log("Scenarios:", json);
  return json.data.map((n: any) => ({
    id: n.id,
    name: n.attributes.title,
    description: n.attributes.field_scenario_description ?? "",
    config: JSON.parse(n.attributes.field_parameters),
  }));
}