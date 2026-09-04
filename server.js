const express = require("express");
const crypto = require("crypto");
const app = express();
app.use(express.json());
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(require("path").join(__dirname, "index.html")));

const PORT = process.env.PORT || 3000;
const PRICE = 350;
const orders = new Map();
const inventory = [];

function id(){ return "NB-"+Date.now()+"-"+crypto.randomBytes(3).toString("hex").toUpperCase(); }

app.post("/api/create-order",(req,res)=>{
  const quantity=Number(req.body.quantity);
  const available=inventory.filter(x=>x.status==="AVAILABLE").length;
  if(!Number.isInteger(quantity)||quantity<1||quantity>100)
    return res.status(400).json({error:"Invalid quantity"});
  if(quantity>available)
    return res.status(400).json({error:available===0?"OUT OF STOCK":`Only ${available} ID(s) available`});
  const orderId=id();
  orders.set(orderId,{orderId,quantity,amount:quantity*PRICE,status:"PENDING",utr:null,credentials:null,inventoryIds:[]});
  res.json({orderId,amount:quantity*PRICE});
});

app.get("/api/order/:id",(req,res)=>{
  const o=orders.get(req.params.id);
  if(!o)return res.status(404).json({error:"Order not found"});
  res.json(o);
});

app.post("/api/submit-utr",(req,res)=>{
  const {orderId,utr}=req.body;
  const o=orders.get(orderId);
  if(!o)return res.status(404).json({error:"Order not found"});
  if(o.status==="PAID")return res.status(400).json({error:"Already approved"});
  if(typeof utr!=="string" || !/^[A-Za-z0-9_-]{6,64}$/.test(utr.trim()))
    return res.status(400).json({error:"Invalid UTR / Transaction ID"});
  o.utr=utr.trim(); o.status="UNDER_REVIEW";
  res.json({ok:true,message:"UTR submitted for admin verification"});
});

function adminAuth(req,res,next){
  const secret=process.env.ADMIN_SECRET;
  if(!secret || req.get("x-admin-secret")!==secret)
    return res.status(401).json({error:"Unauthorized"});
  next();
}

app.get("/api/admin/orders",adminAuth,(req,res)=>{
  res.json({orders:Array.from(orders.values()).map(o=>({
    orderId:o.orderId,quantity:o.quantity,amount:o.amount,status:o.status,utr:o.utr
  }))});
});

app.post("/api/admin/approve",adminAuth,(req,res)=>{
  const o=orders.get(req.body.orderId);
  if(!o)return res.status(404).json({error:"Order not found"});
  if(o.status!=="UNDER_REVIEW")return res.status(400).json({error:"Order is not under review"});
  const available=inventory.filter(x=>x.status==="AVAILABLE");
  if(available.length<o.quantity)return res.status(400).json({error:"Not enough IDs in stock"});
  const picked=available.slice(0,o.quantity);
  picked.forEach(x=>{x.status="SOLD";x.soldOrder=o.orderId;x.soldAt=new Date().toISOString()});
  o.inventoryIds=picked.map(x=>x.id);
  o.credentials=picked.map(x=>({username:x.username,password:x.password}));
  o.status="PAID";
  res.json({ok:true,message:"Payment approved and IDs assigned"});
});

app.post("/api/admin/reject",adminAuth,(req,res)=>{
  const o=orders.get(req.body.orderId);
  if(!o)return res.status(404).json({error:"Order not found"});
  if(o.status!=="UNDER_REVIEW")return res.status(400).json({error:"Order is not under review"});
  o.status="REJECTED";
  res.json({ok:true,message:"Payment request rejected"});
});

// Inventory API
app.get("/api/admin/inventory",adminAuth,(req,res)=>{
  const available=inventory.filter(x=>x.status==="AVAILABLE").length;
  res.json({available,sold:inventory.length-available,total:inventory.length,
    items:inventory.map(x=>({id:x.id,username:x.username,status:x.status,soldOrder:x.soldOrder||null}))});
});

app.post("/api/admin/inventory/add",adminAuth,(req,res)=>{
  const username=String(req.body.username||"").trim();
  const password=String(req.body.password||"");
  if(!username||!password)return res.status(400).json({error:"Username and password required"});
  if(inventory.some(x=>x.username===username))
    return res.status(400).json({error:"Username already exists"});
  inventory.push({id:id(),username,password,status:"AVAILABLE",soldOrder:null});
  res.json({ok:true,message:"ID added"});
});

app.post("/api/admin/inventory/delete",adminAuth,(req,res)=>{
  const item=inventory.find(x=>x.id===req.body.id);
  if(!item)return res.status(404).json({error:"ID not found"});
  if(item.status!=="AVAILABLE")return res.status(400).json({error:"Sold ID cannot be deleted"});
  inventory.splice(inventory.indexOf(item),1);
  res.json({ok:true,message:"ID deleted"});
});

app.listen(PORT,()=>console.log(`NISHAD BRAND running on port ${PORT}`));
