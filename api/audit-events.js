import {getReceiver} from '../lib/runtime.mjs';
export default {async fetch(request){try{return await getReceiver().capture(request);}catch{return Response.json({error:'Capture unavailable'},{status:503});}}};
