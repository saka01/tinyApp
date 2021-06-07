const express  = require("express");
const app = express(); 

app.get("/urls/new", (req, res) => {
  res.render("urls_new");
});


//create a server on a local host like this: 
app.listen(3000,() => {
  console.log("Server running...🚀🚀🚀");
});