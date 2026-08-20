'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
assert(scriptMatch, 'index.html skal indeholde ét script');

const script = scriptMatch[1].replace(/\binit\(\);\s*$/, '');
const context = {
  console,
  Intl,
  Date,
  Math,
  JSON,
  Blob: function Blob(){},
  URL: {},
  AbortSignal: {},
  fetch: async () => { throw new Error('Netværk må ikke bruges i beregningstests'); },
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  localStorage: { getItem: () => null, setItem: () => {} },
  window: { matchMedia: () => ({ matches: true }) },
};
vm.createContext(context);
vm.runInContext(script, context);

function run(source){
  return vm.runInContext(source, context);
}

function close(actual, expected, message){
  assert(Math.abs(actual - expected) < 1e-9, `${message}: forventede ${expected}, fik ${actual}`);
}

const baseInput = `({
  parts:[{hours:2,filaments:[{grams:100,filament:{priceDkk:200,spoolG:1000}}]}],
  wageOn:true,laborMin:15,shipOn:true,shipPost:39,shipPack:8,
  spanOn:false,spanStart:null,spanEnd:null,margin:40,
  printer:{watt:250,cost:8800,lifeHours:5000,hoursAtPurchase:0,used:false},
  platform:{fee:10}
})`;

run(`
  state.settings.manualElOn=false;
  state.settings.manualElPrice=2;
  state.settings.failMode="manual";
  state.settings.failManual=5;
  state.settings.saleVatOn=false;
  state.settings.tillæg=0;
  state.settings.vat=false;
  state.el=null;
  elSeries=[];
`);

{
  const c = run(`compute(${baseInput})`);
  close(c.material, 20, 'materiale');
  close(c.electricity, 1, 'normal strøm');
  close(c.wear, 3.52, 'printerslid');
  close(c.spill, (20 + 1 + 3.52) * 0.05 / 0.95, 'forventet fejlreserve');
  close(c.profit, c.cost * 0.40, 'fortjenestetillæg efter platformgebyr');
}

{
  const c = run(`compute(Object.assign(${baseInput},{
    parts:[{hours:2,filaments:[
      {grams:100,filament:{priceDkk:200,spoolG:1000}},
      {grams:50,filament:{priceDkk:300,spoolG:1000}}
    ]}]
  }))`);
  close(c.material, 35, 'flere filamenter på samme plade');
  close(c.totalHours, 2, 'pladens printtid må kun tælles én gang');
  close(c.electricity, 1, 'strøm må ikke fordobles af flere filamenter');
  close(c.wear, 3.52, 'printerslid må ikke fordobles af flere filamenter');
  assert.equal(c.partRows[0].filaments.length, 2, 'filamentfordelingen skal bevares i beregningsresultatet');
}

{
  const c = run(`compute(Object.assign(${baseInput},{spanOn:true,spanStart:1,spanEnd:4*36e5+1}))`);
  close(c.kwh, 1, 'tidsrummets kWh uden spotserie');
  close(c.electricity, 2, 'fallback-strøm skal bruge tidsrummets kWh');
  close(c.electricity, c.kwh * c.elPrice, 'vist kWh og strømomkostning skal stemme');
}

{
  const span = run(`(() => {
    state.settings.tillæg=0; state.settings.vat=false;
    state.el={spotKrh:2,area:state.settings.area};
    elSeries=[
      {t:0,tEnd:36e5,p:10},
      {t:36e5,tEnd:2*36e5,p:0}
    ];
    return spanElCost(1000,0.9*36e5,4*36e5);
  })()`);
  close(span.avg, 10 / 11, 'tidsvægtet spotgennemsnit');
  close(span.cost, (3.1 * 10 / 11), 'manglende timer bruger tidsvægtet gennemsnit');
}

{
  const c = run(`(() => {
    state.settings.failManual=0;
    state.settings.saleVatOn=true;
    state.settings.saleVatRate=25;
    state.settings.manualElOn=true;
    state.settings.manualElPrice=2;
    return compute(${baseInput});
  })()`);
  close(c.profit, c.cost * 0.40, 'fortjeneste med salgsmoms og gebyr');
  close(c.price - c.salesVat - c.feeAmt - c.cost, c.profit, 'prisfordeling med salgsmoms');
}

{
  const c = run(`(() => {
    state.settings.failManual=20;
    state.settings.saleVatOn=false;
    return compute(${baseInput});
  })()`);
  close(c.retryFactor, 0.25, '20 % fejlrate svarer til 25 % ekstra forsøg pr. succes');
  close(c.spill, (c.material + c.electricity + c.wear) * 0.25, 'fejlreserve inkluderer slid');
  assert(c.failedCost < c.cost, 'faktisk tab på et fejlet print må ikke indeholde fragt eller fejlreserve');
}

{
  const c = run(`compute(Object.assign(${baseInput},{printer:{watt:250,cost:8800,lifeHours:1000,hoursAtPurchase:1000,used:true}}))`);
  assert(c.inputError, 'ugyldig restlevetid skal afvises');
  assert.equal(c.price, 0, 'ugyldig printer må ikke give en salgspris');
}

{
  const count = run(`priceDays(
    new Date(2026,7,19,23,30).getTime(),
    new Date(2026,7,21,0,30).getTime()
  ).length`);
  assert.equal(count, 3, 'alle kalenderdage i et valgt tidsrum skal hentes');
}

{
  const c = run(`(() => {
    state.settings.failMode="auto";
    state.history=Array.from({length:5},(_,i)=>({id:i,failed:true}));
    return compute(${baseInput});
  })()`);
  assert(c.pricingError, '100 % historisk fejlrate skal blokere prisforslaget');
  assert.equal(c.price, 0, '100 % fejlrate må ikke give en endelig pris');
}

console.log('Alle beregningstests bestod.');
