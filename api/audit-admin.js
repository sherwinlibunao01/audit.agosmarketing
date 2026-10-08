import {getReceiver} from '../lib/runtime.mjs';
export default {async fetch(request){try{return await getReceiver().admin(request);}catch{return Response.json({error:'Queue unavailable'},{status:503});}}};
