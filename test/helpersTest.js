const { assert } = require('chai');

const { findUser } = require('../helpers.js');

const testUsers = {
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

describe('#findUser', function() {
  it('should return true if user in database', function() {
    const user = findUser("user@example.com", testUsers);
    
    // Write your assert statement here
    assert.equal(user, true);
  });

  it('should return false if user isnt in database', function() {
    const user = findUser("user@extample.com", testUsers);
    
    // Write your assert statement here
    assert.equal(user, false);
  });

});