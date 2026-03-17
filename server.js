// Simple YGO Draft Server (Railway compatible)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req,res)=>{
  if(req.url === '/' || req.url === '/index.html'){
    const html = fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
    res.writeHead(200,{'Content-Type':'text/html'});
    res.end(html);
    return;
  }

  if(req.url === '/cards.json'){
    const json = fs.readFileSync(path.join(__dirname,'cards.json'),'utf8');
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(json);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT,()=>{
  console.log('Server running on port',PORT);
});
