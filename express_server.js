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

//temporary databases
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
  if (req.session.user_id) {
    return res.redirect("/urls");
  } else {
    return res.redirect("/login");
  }

});

app.get("/login", (req, res) => {
  if (req.session.user_id) {
    return res.redirect("/urls");
  }
  res.render("loginPage");
});


app.post("/login", (req, res) => {

  //finds the user email and authenticate the user
  if (findUser(req.body.email, users)) {
    const personId = authenticateUser(req.body.password, users);
    if (personId) {
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
  //checks if the user was previously logged in
  if (req.session.user_id) {
    return res.redirect("/urls");
  }
  res.render("registerationPage");
});

//deletes cookies and redirect to url page
app.post("/logout", (req, res) => {
  req.session = null;
  res.redirect("/urls");
});

//When someone registers
app.post("/register",(req, res) => {

  //checks if the fields are empty
  if (req.body.email === "" || req.body.password === "") {
    return res.send("put something in the fields");
  }

  //checks if user already exists
  if (findUser(req.body.email, users)) {
    return res.send("User already exists");
  }

  //generates random user Id
  const randomId = generateRandomString();

  //adds user to database
  users[randomId] = {
    id: randomId,
    email: req.body.email,
    password: bcrypt.hashSync(req.body.password, 10)
  };

  //sets new cookie to always Identify user
  req.session.user_id = randomId;
  
  //redrects to the url page
  res.redirect("/urls");
});

app.get("/urls", (req, res) => {
  const templateVars = { urls: urlsForUser(req.session.user_id,urlDatabase), user: users[req.session.user_id] };
  res.render("urls_index", templateVars);
});

app.post("/urls", (req, res) => {
  //Populates the URLS's for the specific user
  const key = generateRandomString();
  urlDatabase[key] = {longURL: req.body.longURL, userID: req.session.user_id};

  res.redirect("/urls");
});

app.post("/urls/:shortURL/delete", (req, res) => {
  //verifys if its the owner and deletes the url
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

//redirects to the longurl of the shorturl
app.get("/u/:shortURL", (req, res) => {

  const userr = urlDatabase[req.params.shortURL];

  if (userr === undefined) {
    return res.send("Invalid Link");
  }
  const longURL = userr.longURL;
  res.redirect(longURL);
});

//checks if the user is logged in or not, then redirects them appropriately
app.get("/urls/new", (req, res) => {
  if (!req.session.user_id) {
    res.redirect("/login");
  }
  const templateVars = {user: users[req.session.user_id]};
  res.render("urls_new", templateVars);
});


app.get("/urls/:shortURL", (req, res) => {
  const key = req.params.shortURL;

  
  if (urlDatabase[key] === undefined) {
    return res.send("Invalid Link");
  }

  //verify its the owner before allowing you to edit the url
  if (req.session.user_id === urlDatabase[key].userID) {
    const templateVars = { shortURL: req.params.shortURL, longURL: urlDatabase[req.params.shortURL].longURL, user: users[req.session.user_id]};
    return res.render("urls_show", templateVars);
  }
  res.send("This is not your link.");
});

app.listen(PORT, () => {
  console.log(`Server running on PORT:${PORT}...🚀`);
});