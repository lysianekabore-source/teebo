#!/bin/bash
export PATH=/nfs/109740507/temp/tools/node-v20.18.1-linux-x64/bin:$PATH
export DATABASE_URL='postgres://teebo@127.0.0.1:5433/teebo'
export TEEBO_ADMIN_EMAIL='hello@teebo.africa'
export TEEBO_ADMIN_PASSWORD='Teebo#Admin2026'
export PORT=3000
export HOST=127.0.0.1
export NODE_ENV=development
export TEEBO_WHATSAPP='+22650321432'
export TEEBO_EMAIL='hello@teebo.africa'
cd /nfs/109740507/temp/teebo/backend
exec node src/server.js
