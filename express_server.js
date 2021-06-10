const express = require("express");
const app = express();
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const PORT = 8080; // default port 8080

app.set("view engine", "ejs");
app.use(bodyParser.urlencoded({extended: true}));
app.use(cookieParser());

const urlDatabase = {
  "b2xVn2": "http://www.lighthouselabs.ca",
  "9sm5xK": "http://www.google.com"
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

const findUser = (email) => {
  for (const key in users) {
    if (users[key].email === email) {
      return true;
    }
  }
  return false;
};

const authenticateUser = (password) => {
  for (const key in users) {
    if (password === users[key].password) {
      return key;
    }
  }
  return false;
};

function generateRandomString() {
  return Math.random().toString(36).substr(2,6);
}

app.get("/", (req, res) => {
  res.send("Hello!");
});

app.get("/login", (req, res) => {
  res.render("loginPage");
});

app.post("/login", (req, res) => {

  if (findUser(req.body.email)) {
    const personId = authenticateUser(req.body.password);
    if (personId) {
      res.cookie("user_id", personId);
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
  res.clearCookie("user_id");
  res.redirect("/urls");
});

app.post("/register",(req, res) => {

  if (req.body.email === "" || req.body.password === "") {
    return res.send("put something in the fields");
  }
  if (findUser(req.body.email)) {
    return res.send("User already exists");
  }
  const randomId = generateRandomString();

  users[randomId] = {
    id: randomId,
    email: req.body.email,
    password: req.body.password
  };

  res.cookie("user_id", randomId);
  res.redirect("/urls");
});

app.get("/urls", (req, res) => {
  const templateVars = { urls: urlDatabase, user: users[req.cookies.user_id] };
  res.render("urls_index", templateVars);
});

app.post("/urls", (req, res) => {
  const key = generateRandomString();
  urlDatabase[key] = req.body.longURL;
  res.redirect("/urls");
});

app.post("/urls/:shortURL/delete", (req, res) => {
  delete urlDatabase[req.params.shortURL];
  res.redirect("/urls");
});

app.post("/urls/:shortURL", (req, res) => {

  const key = req.params.shortURL;
  urlDatabase[key] = req.body.longURL;

  res.redirect("/urls");

});

app.get("/u/:shortURL", (req, res) => {
  const longURL = urlDatabase[req.params.shortURL];
  if (!longURL) {
    res.render("urls_new");
  }
  res.redirect(longURL);
});

app.get("/urls/new", (req, res) => {
  const templateVars = {user: users[req.cookies.user_id]};
  res.render("urls_new", templateVars);
});

app.get("/urls/:shortURL", (req, res) => {
  const templateVars = { shortURL: req.params.shortURL, longURL: urlDatabase[req.params.shortURL], user: users[req.cookies.user_id]};
  res.render("urls_show", templateVars);
});

app.listen(PORT, () => {
  console.log(`Server running on PORT:${PORT}...🚀`);
});