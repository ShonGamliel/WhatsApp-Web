const express = require("express");
const app = express();
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const WebSocket = require("ws");

const CLIENT = "https://whatsapp-web-client.onrender.com";
const MONGODB_ADDRESS = "mongodb+srv://admin:admin@chatify.jayrowv.mongodb.net/?retryWrites=true&w=majority";

const server = app.listen(process.env.PORT || 3002);
const wss = new WebSocket.Server({ server });

mongoose.set("strictQuery", false);
mongoose
  .connect(MONGODB_ADDRESS)
  .then(console.log("Connected to DataBase"))
  .catch((err) => console.log(err));

const SessionSchema = new mongoose.Schema({
  session_id: {
    type: String,
    required: true,
  },
  userid: {
    type: String,
    required: true,
  },
});

const Session = mongoose.model("sessions", SessionSchema);

const UserSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
  },
  password: {
    type: String,
    required: true,
  },
  salt: {
    type: String,
    required: true,
  },
  chats: Array,
  lastSeen: Number,
  newMessages: [String],
});

const User = mongoose.model("User", UserSchema);

const MessageSchema = new mongoose.Schema({
  text: String,
  chatid: String,
  from: {
    type: String,
    ref: "User",
  },
  to: {
    type: String,
    ref: "User",
  },
  fromusername: String,
  tousername: String,
  timestamp: Number,
  status: Number,
});

const Message = mongoose.model("Message", MessageSchema);

class Connections {
  constructor() {
    this.connections = new Map();
  }
  connectUser(id, ws) {
    this.connections.set(id, ws);
  }
  deleteUser(id) {
    this.connections.delete(id);
  }
  send(id, message) {
    if (this.connections.get(id)) {
      this.connections.get(id).send(JSON.stringify(message));
    }
  }
}

let connections = new Connections();

class Views {
  constructor() {
    this.views = new Map();
  }
  addView(userid, viewerid) {
    if (!this.views.get(userid)) this.views.set(userid, []);
    let result = this.views.get(userid);
    result.push(viewerid);
    this.views.set(userid, result);
  }
  removeView(userid, viewerid) {
    if (!this.views.get(userid)) return this.views.set(userid, []);
    let result = this.views.get(userid);
    result = result.filter((id) => viewerid != id);
    this.views.set(userid, result);
  }
  sendMessageToViewers(userid, message) {
    if (!this.views.get(userid)) return this.views.set(userid, []);
    for (let id of this.views.get(userid)) {
      connections.send(id, message);
    }
  }
}

let views = new Views();

wss.on("connection", (ws) => {
  ws.on("message", (message) => {
    message = JSON.parse(message);
    if (message.MyID) {
      connections.connectUser(message.MyID, ws);
      ws.id = message.MyID;
      connections.send(message.MyID, { userReady: true });
      views.sendMessageToViewers(message.MyID, { connectionUpdate: true, userid: message.MyID, connected: true });

      deliverMessages(message.MyID);
    }
    if (message.privateMessage) {
      message.status = 1;
      if (connections.connections.get(message.to)) {
        message.status = 2;
        if (connections.connections.get(message.to).currentProfileView == message.from) {
          message.status = 3;
        }
      }

      saveMessage(message);
      // if (message.to != message.from)
      connections.send(message.to, message);
      connections.send(message.from, message);
    }
    if (message.typing == false) {
      // if (message.to != message.from)
      connections.send(message.to, message);
    }
    if (message.typing == true) {
      // if (message.to != message.from)
      connections.send(message.to, message);
    }
    if (message.connectionCheck) {
      if (connections.connections.get(message.userid)) {
        ws.send(JSON.stringify({ ...message, isConnected: true }));
      } else {
        ws.send(JSON.stringify({ ...message, isConnected: false }));
      }
    }
    if (message.viewOnProfile) {
      if (ws.currentProfileView) {
        views.removeView(ws.currentProfileView, ws.id);
      }
      ws.currentProfileView = message.userid;
      views.addView(message.userid, ws.id);
      readMessages(getChatID(ws.id, message.userid), message.userid);
      connections.send(message.userid, { messagesRead: true, chatid: getChatID(ws.id, message.userid), reader: ws.id, to: message.userid });
    }
  });
  ws.on("close", () => {
    views.sendMessageToViewers(ws.id, { connectionUpdate: true, userid: ws.id, connected: false });
    connections.deleteUser(ws.id);
    setLastSeen(ws.id);
  });
});

async function readMessages(chatid, from) {
  await Message.updateMany({ chatid: chatid, from: from }, { status: 3 });
}

async function deliverMessages(userid) {
  let user = await User.findOne({ _id: userid });
  let chats = user.chats;
  for (let c of chats) {
    connections.send(c, { messageDelivered: true, chatid: getChatID(userid, c) });
  }
  await Message.updateMany({ to: userid, $or: [{ status: 1 }, { status: undefined }] }, { status: 2 });
}

async function setLastSeen(userid) {
  await User.updateOne({ _id: userid }, { lastSeen: Date.now() });
}

app.use(
  cors({
    origin: CLIENT,
    credentials: true,
  })
);



app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(async (req, res, next) => {
  if (req.header("cookies")) {
    req.cookies = parseCookies(req.header("cookies"));
  }

  if (!req.cookies || !req.cookies.connect_sid) return next();
  let sessionFromDB = await Session.findOne({ session_id: req.cookies.connect_sid });
  if (!sessionFromDB) return next();
  let userFromDB = await User.findOne({ _id: sessionFromDB.userid });
  if (!userFromDB) {
    await Session.deleteOne({ _id: sessionFromDB._id });
    return next();
  }
  userFromDB.password = undefined;
  userFromDB.salt = undefined;
  req.user = userFromDB;
  next();
});

app.post("/register", async (req, res) => {
  if (req.user) return res.sendStatus(401);
  if (!req.body.username) return res.send({ error: true, field: "username", message: "enter a username" });
  let user = await User.findOne({ username: req.body.username });
  if (user) return res.send({ error: true, field: "username", message: "username already exists" });
  if (!req.body.password) return res.send({ error: true, field: "password", message: "enter a password" });
  if (req.body.password.length < 4) return res.send({ error: true, field: "password", message: "password must be at least 4 characters" });

  let salt = bcrypt.genSaltSync(10);
  let newUser = await User.create({ username: req.body.username, password: hashPassword(req.body.password, salt), salt: salt, lastSeen: Date.now() });
  let session = newsession();
  res.cookie("connect_sid", session);
  await Session.create({ session_id: session, userid: newUser._id });
  res.send({ authenticated: true, session_id: session, user: newUser });
});

app.post("/logout", async (req, res) => {
  if (!req.user) return res.sendStatus(401);
  let sessionFromDB = await Session.findOne({ session_id: req.cookies.connect_sid });
  req.user = undefined;
  if (sessionFromDB) await Session.deleteOne({ _id: sessionFromDB._id });
  req.user = undefined;
  res.send({ logout: true });
});

app.post("/login", async (req, res) => {
  if (req.user) return res.sendStatus(401);
  if (!req.body.username) return res.send({ error: true, field: "username", message: "enter a username" });

  let userFromDB = await User.findOne({ username: req.body.username });
  if (!userFromDB) return res.send({ error: true, field: "username", message: "username doesnt exists" });
  if (!req.body.password) return res.send({ error: true, field: "password", message: "enter a password" });
  if (!comparePassword(req.body.password, userFromDB.password, userFromDB.salt)) return res.send({ error: true, field: "password", message: "incorrect password" });
  let existedSession = await Session.findOne({ userid: userFromDB._id });
  if (existedSession) await Session.deleteOne({ _id: existedSession._id });

  let session = newsession();
  await Session.create({ session_id: session, userid: userFromDB._id });
  res.send({ authenticated: true, session_id: session, user: userFromDB });
});

app.get("/user", (req, res) => {
  res.send(req.user);
});

function newsession() {
  let result = "";
  const characters = "j5d^zW8XvAa_LK?0kFyR>s`*iG}w)q3%[t@f{E!#o<2Q$6+SU1(4)p9]xO-cJrB&HNhMT^PbnYg7ClIeV}uZ)";
  for (let i = 0; i < characters.length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

function hashPassword(password, salt) {
  const secretCode = "j5d^zW8XvAa_LK?0kFyR>s`*iG}w)q3%[t@f{E!#o<2Q$6+SU1(4)p9]xO-cJrB&HNhMT^PbnYg7ClIeV}uZ)";
  const hashedPassword = bcrypt.hashSync(password + secretCode, salt);
  return hashedPassword;
}

function comparePassword(password, passwordFromDB, saltFromDB) {
  const secretCode = "j5d^zW8XvAa_LK?0kFyR>s`*iG}w)q3%[t@f{E!#o<2Q$6+SU1(4)p9]xO-cJrB&HNhMT^PbnYg7ClIeV}uZ)";
  const hashedPassword = bcrypt.hashSync(password + secretCode, saltFromDB);
  return hashedPassword == passwordFromDB;
}

function parseCookies(source) {
  const lines = source.trim().split("\n");
  const result = {};

  for (const line of lines) {
    const [key, value] = line.split("=");
    result[key] = value;
  }

  return result;
}

app.get("/search/:username", async (req, res) => {
  if (!req.user) return res.sendStatus(401);
  let users = await User.find({ username: { $regex: req.params.username, $options: "i" } });
  users = users.map((item) => {
    return { ...item, fromusername: item.username, tousername: item.username, to: item._id, from: item._id, chatid: getChatID(item._id, req.user._id) };
  });
  res.send(users);
});

app.get("/chats", async (req, res) => {
  if (!req.user) return res.sendStatus(401);
  let user = await User.findOne({ _id: req.user._id });
  if (!user.chats) return res.send([]);
  let result = [];
  for (let c of user.chats) {
    let messages = await Message.find({ chatid: getChatID(req.user._id, c), from: c }, {}, { sort: { timestamp: -1 } });
    let messagesCount = [];
    for (let m of messages) {
      if (m.status == 3) break;
      messagesCount.push(m);
    }

    let last = await Message.findOne(
      {
        chatid: getChatID(req.user._id, c),
      },
      {},
      { sort: { timestamp: -1 } }
    );
    if (last) {
      result.push({ ...last._doc, privateMessage: true, newMessages: messagesCount.length });
    }
  }
  res.send(result);
});

app.get("/chat/:id", async (req, res) => {
  if (!req.user) return res.sendStatus(401);
  let messages = await Message.find({ chatid: getChatID(req.user._id, req.params.id) });
  return res.send(messages);
});

app.get("/newmessages", async (req, res) => {
  if (!req.user) return res.sendStatus(401);
  let user = await User.findOne({ _id: req.user._id });
  return res.send(user.newMessages);
});

function getChatID(id1, id2) {
  let sorted = [id1, id2].sort();
  id1 = sorted[0];
  id2 = sorted[1];
  let result = id1 + id2;
  return result;
}

app.get("/lastseen/:id", async (req, res) => {
  let user = await User.findOne({ _id: req.params.id });
  if (!user) return res.sendStatus(404);
  res.send({ lastSeen: user.lastSeen });
});

async function saveMessage(message) {
  let newMessage = await Message.create(message);
  await User.updateOne({ _id: message.to }, { $addToSet: { chats: message.from } });
  await User.updateOne({ _id: message.from }, { $addToSet: { chats: message.to } });

  await User.updateOne({ _id: message.to }, { $addToSet: { newMessages: newMessage._id } });
}
