const mongoose = require("mongoose");

const zoneSchema = new mongoose.Schema({
 zone:[
   {
     lat:Number,
     lng:Number
   }
 ],
 createdAt:{
   type:Date,
   default:Date.now
 }
});

module.exports = mongoose.model("HighRiskZone",zoneSchema);
