# TAS: Telegram Anti-Spam System - Technical Overview

## Introduction

TAS (Telegram Anti-Spam System) is an advanced solution designed to detect and manage spam in Telegram groups. This document provides a technical overview of the system, its current state, and future development plans.

## System Components

1. Telegram Client: Uses the telegram gramJS library to interact with Telegram's API.
2. Redis Cache: For temporary data storage and quick access to recent decisions.
3. LRU (Least Recently Used) Cache: For rapid checking of repeated spam from the same sender.
4. PostgreSQL Database: For long-term data storage and machine learning purposes.
5. Express Server: Handles API requests and system monitoring.
6. OpenAI API Client: For accessing the GPT-4o-mini model.

## How TAS Works

1. Message Reception and Categorization
   - The system receives messages through the Telegram Client.
   - Messages are categorized into four types:
     a) checkMsg: Messages to be checked for spam.
     b) sysMsg: System messages containing metadata.
     c) addMsg: Additional bot messages (e.g., "No reports found").
     d) adminMsg: Commands from system administrators.

2. Initial Screening
   - The system creates a hash of the message based on its content and sender.
   - This hash is checked against the LRU cache for quick identification of repeated spam.
   - A fast check is performed to identify obvious spam indicators.

3. Deep Content Analysis
   - If the message contains media, it's first analyzed using Google Cloud Vision API.
   - The text content (including any text extracted from images) is then processed by GPT-4o-mini.
   - GPT-4o-mini analyzes the message for spam indicators, considering context and content.

4. Decision Making
   - The system combines results from all checks to determine if the message is spam.
   - This decision is then applied to the report.

5. Result Handling
   - The decision is saved in the LRU cache for quick future reference.
   - The full report is added to a batch for Redis storage.
   - Every 10 minutes or when 100 reports accumulate, the batch is saved to Redis.
   - Every 2 hours, data from Redis is transferred to PostgreSQL for long-term storage.

6. Queue Management
   - The system adaptively adjusts delays between processing commands to optimize performance.
   - If an error occurs, the system can undo recent reports using the undoRecentReports function.