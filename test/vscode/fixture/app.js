const express = require("express");
const app = express();
const users = require("./routes/users");
const admin = require("./admin/panel");
app.use("/api/users", users);
app.use("/admin", admin);
app.get("/", home);
app.get("/login", login);
