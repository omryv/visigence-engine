import { GENRES } from '../genres/registry.js';

/** Authored routes use the same objective graph, collision and export contract as Studio. */
export const GENRE_LEVELS = {
  'survey-v1': {
    genre: 'exploration',
    description: 'Restore the survey station, cross the village, and return with the readings.',
    sites: [[-8,18],[10,-17],[-10,-27],[10,10]],
    steps: [['activate','activate',1,2],['checkpoint','reach',1,1],['extract','extract',1,2]],
  },
  'trail-v1': {
    genre: 'action',
    description: 'Wake the shrine, drive the critters out of the village with the staff, and come home.',
    sites: [[-8,18],[10,-17],[-10,-27],[10,10]],
    steps: [['activate','activate',1,1.5],['clear','eliminate',1,1],['extract','extract',1,1.5]],
  },
  'siege-v1': {
    genre: 'arena',
    description: 'Hold the square against three waves, then last out the swarm.',
    sites: [[-8,18],[10,-17]],
    steps: [['waves','waves',3,1],['hold','survive',1,45],['extract','extract',1,1.5]],
  },
  'harvest-v1': {
    genre: 'collect',
    description: 'Gather the honey drops along the lanes, climb to the lookout, and bring them home.',
    sites: [[-8,18],[10,-17],[-10,-27],[10,10]],
    steps: [['harvest','collect',12,1],['lookout','reach',1,1],['extract','extract',1,1.5]],
  },
};
export const GENRE_PROFILES = { exploration:'survey-v1', action:'trail-v1', arena:'siege-v1', collect:'harvest-v1' };
export function authorGenreMission(project) {
  const profile=GENRE_PROFILES[project.genre],level=GENRE_LEVELS[profile];if(!level)return project;
  project.missionProfile=profile;
  const graph=project.blueprint;
  // A genre without weapons carries none, and no ammunition or fizz-bombs lie about for it.
  if(!GENRES[project.genre]?.weapons){
    const weapons=graph.nodes.find(n=>n.kind==='weapons');if(weapons)weapons.items=[];
    const props=graph.nodes.find(n=>n.kind==='props');if(props)props.items=props.items.filter(id=>!['ammoSupply','grenadeSupply'].includes(id));
  }
  graph.nodes=graph.nodes.filter(n=>n.kind!=='objective');
  graph.edges=graph.edges.filter(e=>!['start','complete'].includes(e.out));
  for(const [i,[id,objective,count,duration]] of level.steps.entries()){
    graph.nodes.push({id,kind:'objective',objective,count,duration,x:560,y:30+i*150});
    graph.edges.push({from:i?level.steps[i-1][0]:'generator',out:i?'complete':'start',to:id,input:'start'});
  }
  graph.edges.push({from:level.steps.at(-1)[0],out:'complete',to:'output',input:'mission'});
  return project;
}
