require("dotenv").config();
let express = require("express");
let path = require("path");
const cors = require("cors");
const { Pool } = require("pg");
const { DATABASE_URL } = process.env;
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");

let app = express();
app.use(cors());
app.use(express.json());

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "images"); // Set destination folder for storing images
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + "-" + file.originalname);
  }
});

const upload = multer({ storage });

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    require: true,
  },
});

async function getPostgresVersion() {
  const client = await pool.connect();

  try {
    const res = await client.query("SELECT version()");
    console.log(res.rows[0]);
  } finally {
    client.release();
  }
};

getPostgresVersion();

app.use("/images", express.static("images"));

// Endpoint to search for a user
app.get("/search/users/:keyword", async (req, res) => {
  const { keyword } = req.params;

  const client = await pool.connect();

  try {
    const users = await client.query(`
      SELECT users.id AS id FROM users
        INNER JOIN user_details ON users.id = user_details.user_id
        WHERE user_name LIKE $1
        OR name LIKE $1;
    `, [`%${keyword}%`]);

    if (users.rowCount > 0) {
      res.json(users.rows);
    }
    else {
      res.status(400).json({ error: "No user found" });
    }
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Endpoint to search for a tweet
app.get("/search/posts/:keyword", async (req, res) => {
  const { keyword } = req.params;

  const client = await pool.connect();

  try {
    const posts = await client.query(`
      SELECT * FROM posts WHERE content LIKE $1 ORDER BY created_at DESC
    `, [`%${keyword}%`]);

    if (posts.rowCount > 0) {
      res.json(posts.rows);
    }
    else {
      res.status(400).json({ error: "No post found" });
    }
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Endpoint that fetch user's not following account
app.get("/follows/:user_id", async (req, res) => {
  const { user_id } = req.params;

  const client = await pool.connect();

  try {
    const notFollowing = await client.query(`
      SELECT id FROM users
      WHERE id NOT IN (
        SELECT following_user_id 
        FROM followers
        WHERE user_id = $1 AND following = true
      )
      AND id IN (
        SELECT users.id from users
        INNER JOIN user_details ON users.id = user_details.user_id
        WHERE users.id = user_details.user_id
      )
      AND id <> $1
    `, [user_id]);

    if (notFollowing.rowCount > 0) {
      res.json(notFollowing.rows);
    }
    else {
      res.status(400).json({ message: "You are already following all users" });
    }
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Endpoint to fetch user's follower and following count
app.get("/follows/count/:user_id", async (req, res) => {
  const { user_id } = req.params;

  const client = await pool.connect();

  try {
    const following = await client.query(`
      SELECT COUNT(*) FROM followers WHERE user_id = $1 AND following = true
    `, [user_id]);

    const follower = await client.query(`
      SELECT COUNT(*) FROM followers WHERE following_user_id = $1 AND following = true
    `, [user_id]);

    res.json({
      following: following.rows[0].count,
      follower: follower.rows[0].count
    });
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Endpoint to fetch following status
app.get("/follows/:user_id/:following_user_id", async (req, res) => {
  const { user_id, following_user_id } = req.params;

  const client = await pool.connect();

  try {
    const following = await client.query(`
      SELECT following FROM followers WHERE user_id = $1 AND following_user_id = $2
    `, [user_id, following_user_id]);

    if (following.rowCount > 0) {
      res.json(following.rows[0]);
    }
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Endpoint to follow a user
app.post("/follows", async (req, res) => {
  const { user_id, following_user_id } = req.body;

  const client = await pool.connect();

  try {
    const prevFollow = await client.query(`
      SELECT * FROM followers WHERE user_id = $1 AND following_user_id = $2 AND following = false
    `, [user_id, following_user_id]);

    if (prevFollow.rowCount > 0) {
      const newFollow = await client.query(`
        UPDATE followers SET following = true WHERE id = $1
      `, [prevFollow.rows[0].id]);

      res.json(newFollow.rows[0]);
    }
    else {
      const newFollow = await client.query(`
        INSERT INTO followers (user_id, following_user_id, created_at, following) 
        VALUES ($1, $2, CURRENT_TIMESTAMP, true) RETURNING *
      `, [user_id, following_user_id]);

      res.json(newFollow.rows[0]);
    }
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Endpoint to unfollow a user
app.put("/follows/:user_id/:following_user_id", async (req, res) => {
  const { following_user_id, user_id } = req.params;

  const client = await pool.connect();

  try {
    await client.query(`
      UPDATE followers 
      SET following = false 
      WHERE user_id = $1 AND following_user_id = $2 AND following = true
    `, [user_id, following_user_id]);
    res.json({ message: "Successfully unfollowed" });
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Endpoint to fetch user's profile details
app.get("/profile/:user_id", async (req, res) => {
  const { user_id } = req.params;

  const client = await pool.connect();

  try {
    const userInfo = await client.query(`
        SELECT username FROM users WHERE id = $1
      `, [user_id]);

    if (userInfo.rowCount > 0) {
      const userDetails = await client.query(`
        SELECT * FROM user_details INNER JOIN users ON user_details.user_id = users.id WHERE user_id = $1
      `, [user_id]);

      if (userDetails.rowCount > 0) {
        const profileImage = userDetails.rows[0].profile_image_path;
        const bannerImage = userDetails.rows[0].banner_image_path;
        const username = userDetails.rows[0].user_name;
        const name = userDetails.rows[0].name;
        const bio = userDetails.rows[0].bio;
        const userId = userDetails.rows[0].user_id

        res.json({ userId, username, name, bio, profileImage, bannerImage });
      }
      else {
        const userId = userInfo.rows[0].id;
        const email = userInfo.rows[0].username;

        res.json({ userId, email });
      }
    }
    else {
      res.status(400).json({ error: "No user found" });
    }
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Endpoint to save user's profile details
app.post("/profile/:user_id", upload.fields([
  { name: "profileImage", maxCount: 1 },
  { name: "bannerImage", maxCount: 1 }
]), async (req, res) => {
  const { user_id } = req.params;
  const { profileImage, bannerImage } = req.files;
  const { username, name, bio } = req.body;

  const client = await pool.connect();

  try {
    const prevUserDetails = await client.query(`
      SELECT * FROM user_details WHERE user_id = $1
    `, [user_id]);

    // Valid image file type
    const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/gif"];

    const isProfileImageValid = !profileImage || allowedTypes.includes(profileImage[0].mimetype);

    const isBannerImageValid = !bannerImage || allowedTypes.includes(bannerImage[0].mimetype);

    // Ensure uploaded image file type is valid
    if (!isProfileImageValid || !isBannerImageValid) {
      return res.status(400).json({ message: "Invalid file format. Please upload valid image files (jpg, jpeg, png, gif)" });
    }

    const usernameExisted = await client.query(`SELECT * FROM user_details WHERE user_name = $1`, [username]);

    // Ensure username is unique
    if (usernameExisted.rowCount > 0) {
      if (usernameExisted.rows[0].user_id !== parseInt(user_id)) {
        return res.status(400).json({ message: "Username already exists" });
      }
    }

    // Update user profile details if row exists
    if (prevUserDetails.rowCount > 0) {
      const newUserDetails = await client.query(`
        UPDATE user_details
        SET (user_name, name, bio, profile_image, profile_image_path, banner_image, banner_image_path) = ($1, $2, $3, $4, $5, $6, $7) WHERE id = $8 RETURNING *
      `, [
        username,
        name,
        bio ? bio : null,
        profileImage ? profileImage[0].filename : prevUserDetails.rows[0].profile_image,
        profileImage ? profileImage[0].path : prevUserDetails.rows[0].profile_image_path,
        bannerImage ? bannerImage[0].filename : prevUserDetails.rows[0].banner_image,
        bannerImage ? bannerImage[0].path : prevUserDetails.rows[0].banner_image_path,
        prevUserDetails.rows[0].id
      ])

      res.json(newUserDetails.rows[0]);
    }
    else {
      // Create new user profile details
      const newUserDetails = await client.query(`
        INSERT INTO user_details (user_id, user_name, name, bio, profile_image, profile_image_path, banner_image, banner_image_path) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
      `, [
        user_id,
        username,
        name,
        bio ? bio : null,
        profileImage ? profileImage[0].filename : null,
        profileImage ? profileImage[0].path : null,
        bannerImage ? bannerImage[0].filename : null,
        bannerImage ? bannerImage[0].path : null
      ]);

      res.json(newUserDetails.rows[0]);
    }
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Endpoint to fetch a specific post
app.get("/posts/:post_id", async (req, res) => {
  const { post_id } = req.params;

  const client = await pool.connect();

  try {
    const post = await client.query(`
      SELECT * FROM posts WHERE id = $1
    `, [post_id]);

    if (post.rowCount > 0) {
      res.json(post.rows[0]);
    }
    else {
      res.status(400).json({ error: "No post found" });
    }
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Get all posts of specific user
app.get("/posts/user/:user_id", async (req, res) => {
  const { user_id } = req.params;

  const client = await pool.connect();

  try {
    const posts = await client.query("SELECT * FROM posts WHERE user_id = $1 ORDER BY created_at DESC", [user_id]);

    if (posts.rowCount > 0) {
      res.json(posts.rows);
    }
    else {
      res.status(404).json({ error: "No posts found for this user" });
    }
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Adding a post based on user id
app.post("/posts", async (req, res) => {
  const { title, content, user_id } = req.body;

  const client = await pool.connect();

  try {
    // Check if user exists
    const userExists = await client.query("SELECT * FROM users WHERE id = $1", [user_id]);
    if (userExists.rows.length > 0) {
      // User exists, add post
      const post = await client.query("INSERT INTO posts (title, content, user_id, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) RETURNING *", [title, content, user_id]);
      // Send new post data back to client
      res.json(post.rows[0]);
    }
    else {
      // User does not exist
      res.status(400).json({ error: "User does not exist" });
    }
  } catch (error) {
    console.log(error.stack);
    res.status(500).json({ error: "Something went wrong, please try again later" });
  } finally {
    client.release();
  }
});

// Endpoint to update a post
app.put("/posts/:post_id", async (req, res) => {
  const { post_id } = req.params;
  const { title, content } = req.body;

  const client = await pool.connect();

  try {
    const updatedPost = await client.query(`
      UPDATE posts SET title = $1, content = $2 WHERE id = $3 RETURNING *
    `, [title, content, post_id]);

    res.json(updatedPost.rows[0]);
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Endpoint to delete a post
app.delete("/posts/:post_id", async (req, res) => {
  const { post_id } = req.params;

  const client = await pool.connect();

  try {
    // Delete all likes related to the post
    await client.query("DELETE FROM likes WHERE post_id = $1", [post_id]);
    // Delete all comments related to the post
    await client.query("DELETE FROM comments WHERE post_id = $1", [post_id]);

    await client.query("DELETE FROM posts WHERE id = $1", [post_id]);

    res.json({ message: "Post deleted successfully" });
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Add views count each time a post is fetched
app.put("/posts/views/:post_id", async (req, res) => {
  const { post_id } = req.params;
  const { views } = req.body;

  const client = await pool.connect();

  try {
    await client.query("UPDATE posts SET views = $1 WHERE id = $2", [views, post_id]);

    const updatedPost = await client.query("SELECT * FROM posts WHERE id = $1", [post_id]);
    res.json(updatedPost.rows[0]);
  } catch (error) {
    console.log(error.stack);
    res.status(500).send("An error occured, please try again.");
  } finally {
    client.release();
  }
});

// Endpoint to like a post
app.post("/likes", async (req, res) => {
  const { user_id, post_id } = req.body;

  const client = await pool.connect();

  try {
    // Check if an inactive like for this user and post already exists
    const prevLike = await client.query(`
      SELECT * FROM likes WHERE user_id = $1 AND post_id = $2 AND active = false
    `, [user_id, post_id]);

    if (prevLike.rowCount > 0) {
      // If the inactive like exists, update it to active
      const newLike = await client.query(`
        UPDATE likes SET active = true WHERE id = $1 RETURNING *
      `, [prevLike.rows[0].id]);
      res.json(newLike.rows[0]);
    }
    else {
      // If it does not exist, insert new like row with active as true
      const newLike = await client.query(`
      INSERT INTO likes (user_id, post_id, created_at, active)
      VALUES ($1, $2, CURRENT_TIMESTAMP, true)
      RETURNING *
    `, [user_id, post_id]);
      res.json(newLike.rows[0]);
    }
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Endpoint to unlike a post
app.put("/likes/:user_id/:post_id", async (req, res) => {
  const { user_id, post_id } = req.params;

  const client = await pool.connect();

  try {
    // Update the like row to inactive
    await client.query(`
      UPDATE likes
      SET active = false
      WHERE user_id = $1 AND post_id = $2 AND active = true
    `, [user_id, post_id]);
    res.json({ message: "The like has been removed successfully!" });
  } catch (error) {
    console.error("Error: ", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

// Endpoint to get likes for a specific post
app.get("/likes/post/:post_id", async (req, res) => {
  const { post_id } = req.params;

  const client = await pool.connect();

  try {
    const likes = await client.query(`
      SELECT users.username, users.id AS user_id, likes.id AS likes_id
      FROM likes
      INNER JOIN users ON likes.user_id = users.id
      WHERE likes.post_id = $1 AND active = true
    `, [post_id]);
    res.json(likes.rows);
  } catch (error) {
    console.log(error.stack);
    res.status(500).send("An error occured, please try again.");
  } finally {
    client.release();
  }
});

// Add comment to a post
app.post("/comments", async (req, res) => {
  const { user_id, post_id, content } = req.body;

  const client = await pool.connect();

  try {
    // Check if user exists
    const userExist = await client.query("SELECT * FROM users WHERE id = $1", [user_id]);
    // Check if post exists
    const postExist = await client.query("SELECT * FROM posts WHERE id = $1", [post_id]);

    // Return error message if user or post does not exist
    if (userExist.rows.length === 0) {
      return res.status(400).json({ error: "User does not exist" });
    }
    else if (postExist.rows.length === 0) {
      return res.status(400).json({ error: "Post does not exist" });
    }

    // Add comment into comments table
    const newComment = await client.query("INSERT INTO comments (user_id, post_id, content, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) RETURNING *", [user_id, post_id, content]);
    res.json(newComment.rows[0]);
  } catch (error) {
    console.log(error.stack);
    res.status(500).json({ error: "Something went wrong, please try again later" });
  } finally {
    client.release();
  }
});

// Fetch all comments for the specific post
app.get("/comments/post/:post_id", async (req, res) => {
  const { post_id } = req.params;

  const client = await pool.connect();

  try {
    const comments = await client.query(`
      SELECT comments.id AS id, comments.user_id AS user_id, post_id, content, created_at
      FROM comments 
      INNER JOIN user_details 
      ON comments.user_id = user_details.user_id 
      WHERE post_id = $1
      ORDER BY created_at DESC
    `, [post_id]);
    res.json(comments.rows);
  } catch (error) {
    console.log(error.stack);
    res.status(500).json({ error: "Something went wrong, please try again later" });
  } finally {
    client.release();
  }
});

// Update a specific comment
app.put("/comments/:comment_id", async (req, res) => {
  const { comment_id } = req.params;
  const { user_id, post_id, content } = req.body;

  const client = await pool.connect();

  try {
    // Check if user exists
    const userExist = await client.query("SELECT * FROM users WHERE id = $1", [user_id]);
    // Check if post exists
    const postExist = await client.query("SELECT * FROM posts WHERE id = $1", [post_id]);

    // Return error message if user or post does not exist
    if (userExist.rows.length === 0) {
      return res.status(400).json({ error: "User does not exist" });
    }
    else if (postExist.rows.length === 0) {
      return res.status(400).json({ error: "Post does not exist" });
    }

    // Update comment
    const updatedComment = await client.query("UPDATE comments SET content = $1 WHERE id = $2 AND user_id = $3 AND post_id = $4 RETURNING *", [content, comment_id, user_id, post_id]);
    res.json(updatedComment.rows[0]);
  } catch (error) {
    console.log(error.stack);
    res.status(500).json({ error: "Something went wrong, please try again later" });
  } finally {
    client.release();
  }
});

// Delete comment from a post
app.delete("/comments/:comment_id", async (req, res) => {
  const { comment_id } = req.params;

  const client = await pool.connect();

  try {
    await client.query("DELETE FROM comments WHERE id = $1", [comment_id]);
    res.json({ message: "Comment deleted successfully" });
  } catch (error) {
    console.log(error.stack);
    res.status(500).send("An error occured, please try again.");
  } finally {
    client.release();
  }
});

// Adding a like to a comment
app.post("/comment_likes", async (req, res) => {
  const { user_id, comment_id } = req.body;

  const client = await pool.connect();

  try {
    const prevLike = await client.query(`
      SELECT * FROM comment_likes WHERE user_id = $1 AND comment_id = $2 AND active = false
    `, [user_id, comment_id]);

    if (prevLike.rowCount > 0) {
      const newLike = await client.query(`
        UPDATE comment_likes SET active = true WHERE id = $1 RETURNING *
      `, [prevLike.rows[0].id]);

      res.json(newLike.rows[0]);
    }
    else {
      const newLike = await client.query(`
        INSERT INTO comment_likes (user_id, comment_id, created_at, active)
        VALUES ($1, $2, CURRENT_TIMESTAMP, true)
        RETURNING *
      `, [user_id, comment_id]);

      res.json(newLike.rows[0]);
    }
  } catch (error) {
    console.log(error.stack);
    res.status(500).send("An error occured, please try again.");
  } finally {
    client.release();
  }
});

// Delete like from a comment
app.put("/comment_likes/:user_id/:comment_id", async (req, res) => {
  const { user_id, comment_id } = req.params;

  const client = await pool.connect();

  try {
    await client.query(`
      UPDATE comment_likes
      SET active = false
      WHERE user_id = $1 AND comment_id = $2 AND active = true
    `, [user_id, comment_id]);

    res.json({ message: "Like deleted successfully" });
  } catch (error) {
    console.log(error.stack);
    res.status(500).send("An error occured, please try again.");
  } finally {
    client.release();
  }
});

// Endpoint to fetch all likes for a specific comment
app.get("/comment_likes/comment/:comment_id", async (req, res) => {
  const { comment_id } = req.params;

  const client = await pool.connect();

  try {
    // Fetch all likes for the specific comment
    const likes = await client.query(`
      SELECT users.username, users.id AS user_id, comment_likes.id AS comment_likes_id
      FROM comment_likes 
      INNER JOIN users ON comment_likes.user_id = users.id 
      WHERE comment_likes.comment_id = $1
    `, [comment_id]);
    res.json(likes.rows);
  } catch (error) {
    console.log(error.stack);
    res.status(500).send("An error occured, please try again.");
  } finally {
    client.release();
  }
});

app.get("/", (req, res) => {
  res.status(200).json({ message: "Welcome to the twitter API!" });
});

app.listen(3000, () => {
  console.log("App is listening on port 3000");
});