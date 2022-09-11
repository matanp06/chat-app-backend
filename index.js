require('dotenv').config();
const express = require("express");
const cors = require("cors");
const https = require('https');
const http = require("http");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const {Server} = require("socket.io");
const { emit } = require('process');

// --------------------------------------------------------------------------------------
// Server Section
const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(__dirname+'/public'));

const options = {
    key: process.env.KEY,
    cert: process.env.CRT
};

const server = https.createServer(options,app);
server.listen(4000,function(){
    console.log("server is running with https");
});

const httpServer = http.createServer(app);
httpServer.listen(4001,function(){
    console.log("http is running");
})

const io = new Server(httpServer,{
    cors: {
        origin: "*",
      }
});

mongoose.connect('mongodb://localhost:27017/whatsapp');

const messageSchema = new mongoose.Schema({
    senderUserName: String,
    message: String,
    date: Date
})

const chatSchema = new mongoose.Schema({
    users:[String], // max of two users
    messages: [messageSchema]
})

const friendSchema = new mongoose.Schema({
    username:String
})

const userSchema = new mongoose.Schema({
    username: String,
    password: String,
    friends: [friendSchema],
    chats: [chatSchema]
})

const User = mongoose.model('User',userSchema);



//respone to 404
app.get('/', function (req, res) {
    res.set('Access-Control-Allow-Origin', '*');
    res.send({msg:"success"});
})

// Sockets
io.on("connection",(socket)=>{

    //When user enter a chat
    socket.on("joinChat",async (credencials)=>{

        const {currentUser, _chatId, otherUser } = credencials;
        // if chat id exists
        if(_chatId && _chatId!=""){
            //find the wanted chat
            const {chats:[chat]} = await User.findOne({
                username: currentUser,
                chats:{
                    $elemMatch:{_id: _chatId}
                }},"-_id chats.$");
            
            if(_chatId == chat._id)
                socket.join("chat/"+_chatId);// join the user to the chat room

        }

    })

    //when sending a chat message
    // UPDATE THE RES.SEND TO SOCKET.EMIT
    socket.on("chatMessage", message=>{
        

        const {username,toUser,message:content,_chatId} = message;

        // authenticating the user
        User.findOne({username:username}, async function(err,user){
            if(err){
                console.log(err)
            } else if(user){// user exist

                const otherUser = await User.findOne({username:toUser})
                // second user in the chat exists
                if(otherUser){

                    //trying to find the wanted chat
                    const chatExists = user.chats.find(chat => {
                        return chat.users.find(user => user === otherUser.username)
                    });

                    // formating the message to match the DB requirements
                    let message = {
                        senderUserName: user.username,
                        message: content,
                        date: new Date()
                    }
                    // chat exist => sending message
                    if(_chatId){
                        updateChat(user.username,otherUser.username,message,_chatId);
                        // socket.to("chat/"+_chatId).emit("chatMessage",message);
                    }
                        
    
                    else if(chatExists){


                        // update the chat messages
                        updateChat(user.username,otherUser.username,message,chatExists._id.toString());


                    } else {// chat doesn't exists => create a new chat in the DB
                        
                        //Formating the chat to match the DB requirements
                        let chat = {
                            users: [user.username,otherUser.username],
                            messages: [message]
                        }
                        
                        // adding the Chat to the DB
                        User.updateMany({
                            $or:[
                                {'username':user.username},
                                {'username':otherUser.username}
                            ]
                        },{$push:{"chats":chat}},function(err){
                            if(err){
                                console.log(err);
                                res.send({
                                    type:"ERR",
                                    message:"we had an error please try again later"
                                });
                            } else {
                                //finding the new chat id
                                User.findOne({'username':user.username,
                                    chats:{$elemMatch:{"users":otherUser.username}}
                                    },"chats.$",function(err,result){
                                        if(err){
                                            console.log(err)
                                        } else {
                                            socket.join("chat/"+result.chats[0]._id.toString());
                                            socket.to("chat/"+result.chats[0]._id.toString()).emit("chatMessage",message);
                                        }
                                    })
                            }
                        });

                    }
                } else {// other user doesn't exists
                    res.send({
                        type:"ERR",
                        message:"The user that should accept the message doesn't exists"
                    })
                }
                
            } else { // the sender user doesn't exists
                res.send({
                    type:"ERR",
                    message:"The sender user doesn't exists"
                });
            }
        })

        function updateChat(user,otherUser,message,_id){

            User.updateMany({$or:[
                {'username':user},
                {'username':otherUser}], chats:{$elemMatch:{_id: _id}}},
                {$push: {"chats.$.messages" :message}},function(err,$){
                if(err){
                    console.log(err);
                } else {
                    //sending the message to the user via socket
                    socket.to("chat/"+_id).emit("chatMessage",message);
                }
            });

        }

    })
})

// searching for a user in all the users db
app.get("/user/:username/:currentUser",async function(req,res){
    const username = req.params.username;// the username trying to find
    const currentUser = req.params.currentUser; // the searching user

    //username is a valid user
    if(username!="" && username){

        //finding the currentUser friends
        const [{friends}] = await User.find({username:currentUser},"-_id friends");

        // Searching for the wanted user
        User.find({username:username},"-_id username",function(err,users){
            if(err){
                res.send({
                    type:"ERR",
                    message:"We had an error please try again"
                })
            } else {

                //filtering from the found users the friends of the current user
                users = users.filter( user => {
                   return ((user.username != currentUser)&&
                        (!friends.find(friend=> friend.username===user.username)))
                });
                res.send(users);
            }
        })
    } else {
        res.send({
            type:"ERR",
            message:"username field can't left empty"
        })
    }
})


//getting all the friends of the user
app.get("/friends/:username",async function(req,res){

    const username = req.params.username;

    try {

        // retrive the the user from DB
        const user = await User.findOne({username:username},"-_id friends");
        res.send(user.friends);
        
    } catch(err){
        console.log(err);
        res.send({
            type: "ERR",
            message:"We had a problem please try again"
        })
    }

})


// Adding friend
app.patch("/user/:currentUser",async function(req,res){
    const currentUserName = req.params.currentUser;
    const friendToAdd = req.body.friend;

    if(currentUserName!="" && currentUserName){
        if(friendToAdd!="" && friendToAdd){
            try{
                // getting all the user friends
                const [userFriendsFillter] = await User.find({username:currentUserName});

                if(userFriendsFillter)
                {
                    //finding the future friend in the DB
                    const friend = await User.findOne({username:friendToAdd});

                    if(friend){ // friend exists

                        // checking if the users are already friends
                        if(userFriendsFillter.friends.find(f=>f.username === friend.username)){
                            res.send({
                                type:"ERR",
                                message:"you are already friends :)"
                            });
                        } else {// the users are not friends 

                            //adding the "wanted user" to the user friends
                            User.updateOne(
                                {_id:userFriendsFillter._id},
                                {$push: {friends:{username: friend.username,_id:friend._id}}},
                                function(err,user){
                                    if(err){
                                        console.log(err);
                                        res.send({
                                            type:"ERR",
                                            message:"We had a problem please try again"
                                        })
                                    } else {
                                        res.send({
                                            type:"SUCCESS",
                                            userDetails:{
                                                username:friend.username,
                                                _id:friend._id
                                            }
                                        })
                                    }
                                })
                        }
                    }
                    else{
                        res.send({
                            type:"ERR",
                            message:"your friend doesn't exist :0"
                        })
                    }
                } else {
                    res.send({
                        type:"ERR",
                        message:"your user doesn't exist"
                    });
                }


            } catch(err) {
                console.log(err);
                res.send("we had an error please try again");
            }
            
        } else { // the second user's username was not supplied

            res.send({
                type:"ERR",
                message:"username isn't valid"
            });

        }
    }  else { // the currentUser's username was not supplied

        res.send({
            type:"ERR",
            message:"username isn't valid"
        });

    }
})

// Registering a new user
app.post('/user',function(req,res){
    const {username,password} = req.body;

    // checking if wanted username and password supplied
    if((!username || username=="")||(!password || password=="")){
        res.send({
            type: "ERR",
            message: "one field or more are not filled"
        })
    }

    else{
        
        // Checking if the username is already taken
        // else registering the user
        User.findOne({username:username},function(err,user){
            if(err){
                console.log(err);
                res.send({
                    type:"ERR",
                    message:"We had a problem please try again later"
                });
            } else if(user){// user name is already taken
                res.send({
                    type:"ERR",
                    message:"this username is already taken"
                });
            } else {// username is not taken
                const user = new User({
                    username: username,
                    password: password
                })

                // creating a new user
                user.save().then(()=>{
                    res.send({
                        type:"SUCCESS"
                    });
                }).catch((err)=>{
                    console.log(err);
                    res.send({
                        type: "ERR",
                        message: "We had a problem please try again"
                    });
                });
            }
        })
    }
})


//Deleting all the users: for test perpose only!
app.delete("/users",function(req,res){
    User.deleteMany({},function(err){
        if(err){
            console.log(err);
            res.send({
                type:"ERR",
                message:"We had a problem please try again"
            })
        } else {
            res.send({
                type:"SUCCESS",
                message:"deleted all the users"
            });
        }
    });
});

// Login
app.post("/login",function(req,res){
    const {username,password} = req.body;

    // Checking if the username exists
    User.findOne({username:username},function(err,user){
        if(err){
            console.log(err);
            res.send({
                type:"ERR",
                message:"we had an error please try again"
            });
        } else if(user) { //user exists

            if(user.password === password){// password matches
                res.send({type:"SUCCESS"});
            } else {// password doesn't matches
                res.send({
                    type:"ERR",
                    message:"username or password is incorrect"
                });
            }
        } else {
            res.send({
                type:"ERR",
                message:"username or password is incorrect"
            });
        }
    });
});

//Retriving all the chats of the current user
app.get("/:currentUser/chats",async function(req,res){

    const currentUser = req.params.currentUser;
    try{
        
        // extracting the wanted user from the DB
        const user = await User.findOne({username: currentUser}); 
        if(user){// user exists in the DB
            let {chats} = user; // extracting all the chats

            //formating the chats to fit for the preview in the app.
            chats = chats.map(chat => {
                return {
                    username: chat.users.find(user => user!=currentUser),
                    chatId: chat._id,
                    lastMessage: chat.messages[chat.messages.length-1]
                }
            });
            
            res.send({
                type:"SUCCESS",
                chats:chats
            });

        } else { // the user isn't exists

            res.send({
                type:"ERR",
                message:"username isn't exists"
            });

        }
        

    }catch (err){

        console.log(err);    
        res.send({
            type:"ERR",
            message:"We had a problem please try again later"
        })
    

    }

})

// Getting the chat content
app.get("/:currentUser/chat/:otherUser",function(req,res){

    const {currentUser,otherUser} = req.params; //extracting req params

    //vlidating user
    if((currentUser)&&(currentUser!="")){

        //validating otherUser
        if((otherUser)&&(otherUser!="")){

            //Extracting user information
            User.findOne({username:currentUser},function(err,user){
                if(err){
                    res.send({
                        type:"ERR",
                        message:"we had a problem, please try again later"
                    })    
                } else if(user){ // user exists
                    
                    //finding the wanted chat
                    const chat = user.chats.find(chat => {
                        // the user in the chats is a string
                        return chat.users.find(user =>  user == otherUser)
                    })  
                    
                    if (chat){ // the wanted chat exists
                        res.send({
                            type:"SUCCESS",
                            chat:{
                                messages: chat.messages,
                                _id: chat._id
                            }
                        });
                    }
                    else { // the wanted chat doesn't exists
                        res.send({
                            type:"SUCCESS",
                            chat:{
                                messages: [],
                                _id: null
                            }
                        })
                    }
                    
                } else { // user doesn't exists
                    res.send({
                        type:"ERR",
                        message:"we didn't found your user"
                    });
                }
            })

        } else {// the second username didn't supplied
            res.send({
                type:"ERR",
                message:"username isn't valid"
            })
        }

    } else { // the first username didn't supplied
        res.send({
            type:"ERR",
            message:"username isn't valid"
        })
    }

})


// --------------------------------------------------------------------------------------
//former not secure communication
// app.listen(3000, function () {
//     //console.log('im listening');
// });
// --------------------------------------------------------------------------------------






// Server section end
// --------------------------------------------------------------------------------------
