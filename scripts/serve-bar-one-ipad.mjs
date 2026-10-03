/** Local bridge preserving the installed iPad's temporary tunnel address. Auth stays on the venue backend. */
import http from 'node:http';
const host = process.env.ONECLUB_BRIDGE_HOST;
const octets = host?.split('.').map(Number) || [];
if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255) ||
 !(octets[0] === 10 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31))) {
 throw new Error('Set ONECLUB_BRIDGE_HOST to this Mac’s explicit private LAN address.');
}
const server = http.createServer((request, response) => {
 const upstream = http.request({ hostname:'127.0.0.1',port:8480,path:request.url,method:request.method,headers:request.headers }, result => {
  response.writeHead(result.statusCode || 502,result.headers);result.pipe(response);
 });
 upstream.setTimeout(15000,()=>upstream.destroy(new Error('Venue server timeout')));
 upstream.on('error',()=>{if(!response.headersSent){response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'Venue server reconnecting. Retry shortly.',code:'venue_reconnecting'}}));}else response.destroy();});
 request.on('aborted',()=>upstream.destroy());response.on('close',()=>{if(!response.writableEnded)upstream.destroy();});
 request.pipe(upstream);
});
server.listen(8470,host,()=>console.log(`iPad bridge ${host}:8470 → 127.0.0.1:8480`));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
