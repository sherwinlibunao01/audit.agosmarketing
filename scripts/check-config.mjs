import {readFileSync,copyFileSync} from 'node:fs';
for(const name of ['apple-touch-icon.png','favicon-16.png','favicon-32.png','icon-512.png','llms.txt','og-image.png','robots.txt','site.webmanifest','sitemap.xml'])copyFileSync(name,'public/'+name);
const ids=JSON.parse(readFileSync('lib/field-ids.json','utf8'));
if(Object.keys(ids).length!==13||Object.values(ids).some(x=>!x))throw Error('Audit fields not mapped');
const html=readFileSync('public/index.html','utf8');
if(html.includes('pit-'))throw Error('Credential found in public HTML');
console.log('Public audit and 13 field mappings ready.');
