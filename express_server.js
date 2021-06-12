const express = require("express");
const app = express();
const bodyParser = require("body-parser");
const bcrypt = require('bcrypt');
const cookieSession = require("cookie-session");
const {findUser, authenticateUser, urlsForUser, generateRandomString } = require("./helpers");

const PORT = 8080; // default port 8080

app.set("view engine", "ejs");
app.use(bodyParser.urlencoded({extended: true}));
app.use(cookieSession({
  name: 'session',
  keys: ['key1']
}));

const urlDatabase = {
  "b2xVn2": {longURL: "http://www.lighthouselabs.ca"},
  "9sm5xK": {longURL: "http://www.google.com"}
};

const users = {
  "userRandomID": {
    id: "userRandomID",
    email: "user@example.com",
    password: "purple-monkey-dinosaur"
  },
  "user2RandomID": {
    id: "user2RandomID",
    email: "user2@example.com",
    password: "dishwasher-funk"
  }
};



app.get("/", (req, res) => {
  res.send("Hello!");
});

app.get("/login", (req, res) => {
  res.render("loginPage");
});

app.post("/login", (req, res) => {

  if (findUser(req.body.email, users)) {
    const personId = authenticateUser(req.body.password, users);
    if (personId) {
      // res.cookie("user_id", personId);
      req.session.user_id = personId;
      res.redirect("/urls");
    } else {
      res.send("invalid credentials");
    }
  } else {
    res.send("please register");
  }
});

app.get("/register", (req, res) => {
  res.render("registerationPage");
});

app.post("/logout", (req, res) => {
  req.session = null;
  res.redirect("/urls");
});

app.post("/register",(req, res) => {

  if (req.body.email === "" || req.body.password === "") {
    return res.send("put something in the fields");
  }
  if (findUser(req.body.email, users)) {
    return res.send("User already exists");
  }
  const randomId = generateRandomString();

  users[randomId] = {
    id: randomId,
    email: req.body.email,
    password: bcrypt.hashSync(req.body.password, 10)
  };

  req.session.user_id = randomId;
  
  res.redirect("/urls");
});

app.get("/urls", (req, res) => {
  const templateVars = { urls: urlsForUser(req.session.user_id,urlDatabase), user: users[req.session.user_id] };
  res.render("urls_index", templateVars);
});

app.post("/urls", (req, res) => {
  const key = generateRandomString();
  urlDatabase[key] = {longURL: req.body.longURL, userID: req.session.user_id};

  res.redirect("/urls");
});

app.post("/urls/:shortURL/delete", (req, res) => {
  const key = req.params.shortURL;
  if (req.session.user_id === urlDatabase[key].userID) {
    delete urlDatabase[req.params.shortURL];
    return res.redirect("/urls");
  }
  res.send("boy, get yo scamming ass on boy");
});

app.post("/urls/:shortURL", (req, res) => {
  const key = req.params.shortURL;
  if (req.session.user_id === urlDatabase[key].userID) {
    urlDatabase[key] = {longURL: req.body.longURL, userID: req.session.user_id};

    return res.redirect("/urls");
  }
  res.send("This is not your link");

});

app.get("/u/:shortURL", (req, res) => {

  const userr = urlDatabase[req.params.shortURL];

  if (userr === undefined) {
    return res.send("Invalid Link");
  }

  const longURL = userr.longURL;

 
  res.redirect(longURL);
});

app.get("/urls/new", (req, res) => {
  if (!req.session.user_id) {
    res.redirect("/login");
  }
  const templateVars = {user: users[req.session.user_id]};
  res.render("urls_new", templateVars);
});

app.get("/urls/:shortURL", (req, res) => {
  const key = req.params.shortURL;

  if (req.session.user_id === urlDatabase[key].userID) {
    const templateVars = { shortURL: req.params.shortURL, longURL: urlDatabase[req.params.shortURL].longURL, user: users[req.session.user_id]};
    return res.render("urls_show", templateVars);
  }
  res.send("This is not your link.");
});

app.listen(PORT, () => {
  console.log(`Server running on PORT:${PORT}...🚀`);
});