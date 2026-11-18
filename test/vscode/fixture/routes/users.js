const router = require("express").Router();
router.get("/", list);
router.get("/:id", show);
router.delete("/:id", remove);
db.query("SELECT * FROM users WHERE id = " + req.params.id);
