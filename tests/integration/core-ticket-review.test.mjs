import assert from 'node:assert/strict';
import test from 'node:test';
import { CommunitySubmissions, DurableCommunityState } from '@superagent/plugin-host';
import { fixture } from './helpers.mjs';

const guildId='100';
const binding={projectId:'review-private',sourceId:'review-tickets',sourceUri:`urn:superagent:source:discord:${guildId}:tickets`,platform:'discord'};
const scope={projectId:binding.projectId,sourceId:binding.sourceId};
const ticketEvent=(id,userId='700')=>({specversion:'1.0',id:`discord-community:${id}`,source:binding.sourceUri,
  type:'com.superagent.feedback.message.created.v1',time:'2026-11-02T00:00:00.000Z',datacontenttype:'application/json',
  data:{schemaVersion:'1.0',projectId:scope.projectId,sourceId:scope.sourceId,platform:'discord',
    object:{kind:'message',externalId:id,revision:'ticket'},actor:{opaqueId:userId},content:{text:'[bug] Title\n\nBody'},
    attributes:{guildId,ticketKind:'bug',interactionId:id,native:{title:'Title',body:'Body',kind:'bug',interactionId:id}}}});

test('recovery replaces a closed stale open index with the user’s actual existing open ticket',t=>{
  const f=fixture(t);f.runtime.ingress.registerSource(binding);f.runtime.ingress.setSourcePolicy(scope,{visibility:'staff',processingMode:'archive_only'});
  const state=new DurableCommunityState(f.runtime.store,`discord-community:${guildId}`,{clock:f.clock,leaseOwner:'review-owner'});
  assert.equal(state.acquireLease('review-owner',45_000),true);
  const submissions=new CommunitySubmissions(f.runtime.ingress,state,{scope,guildId,clock:f.clock});
  submissions.submitTicket(ticketEvent('9401'));
  state.setSync('ticket:9400',{...state.getSync('ticket:9401'),id:'9400',status:'closed'});
  state.setSync('ticket:open:700','9400');

  submissions.recover();
  assert.equal(state.getSync('ticket:9400').status,'closed');
  assert.equal(state.getSync('ticket:9401').status,'pending_create');
  assert.equal(state.getSync('ticket:open:700'),'9401');
  assert.equal(submissions.submitTicket(ticketEvent('9402')).status,'existing');
  assert.equal(state.getSync('ticket:9402'),null);
  assert.equal(state.getSync('ticket:open:700'),'9401');
});
