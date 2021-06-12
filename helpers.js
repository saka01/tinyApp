
const bcrypt = require('bcrypt');

const findUser = (email, users) => {
  for (const key in users) {
    if (users[key].email === email) {
      return true;
    }
  }
  return false;
};

const authenticateUser = (password, users) => {
  for (const key in users) {
    if (bcrypt.compareSync(password, users[key].password)) {
      return key;
    }
  }
  return false;
};

const urlsForUser = (id, urlDatabase) => {
  const allUrls = {};

  for (const url in urlDatabase) {
    if (id === urlDatabase[url].userID) {
      allUrls[url] = {longURL: urlDatabase[url].longURL};
    }
  }
  return allUrls;
};

const generateRandomString = () => {
  return Math.random().toString(36).substr(2,6);
};

module.exports = {
  findUser,
  authenticateUser,
  urlsForUser,
  generateRandomString
};